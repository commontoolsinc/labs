// Google Cloud access plus a minimal BigQuery query, over REST — no bq/gcloud CLI.
//
// Access tokens come from one of two sources, in this order:
//   - GCP_SA_KEY: a service-account key (the whole JSON file, as the env value).
//     Its private key signs a JWT that is exchanged for a short-lived access
//     token. This is the local-development path.
//   - the GCE/GKE metadata server, which returns an access token for the
//     workload's own service account. This is the in-cluster path (Workload
//     Identity), where no key is stored anywhere.
//
// BigQuery has no API-key auth: a key does not identify a principal, and every
// query runs as some service account. So this is the closest analogue to the
// GitHub tiles' bearer token — a token obtained without a CLI.

export interface SaKey {
  client_email: string;
  private_key: string; // PEM, PKCS#8
  token_uri: string;
}

// Running a query is jobs.query, which does not accept the bigquery.readonly
// scope; cloud-platform.read-only is the narrowest scope it does accept, and
// being read-only the token cannot mutate anything. IAM on the service account
// (Data Viewer + Job User) is the real limit on what it can reach.
const BQ_SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
const METADATA = "http://metadata.google.internal/computeMetadata/v1";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

// A PEM PKCS#8 private key -> a Web Crypto RS256 signing key.
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// The signed service-account assertion: a JWT claiming the read-only scope,
// signed with the key's private key. `nowSec` is the current time in whole
// seconds. Exported for tests (its signature can be verified with the public key).
export async function saAssertion(key: SaKey, nowSec: number): Promise<string> {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "RS256", typ: "JWT" });
  const body = enc({ iss: key.client_email, scope: BQ_SCOPE, aud: key.token_uri, iat: nowSec, exp: nowSec + 3600 });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importPkcs8(key.private_key),
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

// Exchange a service-account assertion for an access token at the token endpoint.
async function tokenFromKey(key: SaKey): Promise<string> {
  const assertion = await saAssertion(key, Math.floor(Date.now() / 1000));
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error("token exchange returned no access_token");
  return json.access_token;
}

// Ask the metadata server for the workload's own service-account access token.
async function tokenFromMetadata(): Promise<string> {
  const res = await fetch(`${METADATA}/instance/service-account/default/token`, {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`metadata token failed: HTTP ${res.status}`);
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error("metadata server returned no access_token");
  return json.access_token;
}

async function accessToken(env: (k: string) => string | undefined): Promise<string> {
  const raw = env("GCP_SA_KEY");
  return raw ? await tokenFromKey(JSON.parse(raw) as SaKey) : await tokenFromMetadata();
}

// Flatten a jobs.query response to a grid of string cells (BigQuery returns every
// scalar as a string). Exported for tests.
export function bqRows(json: unknown): string[][] {
  const j = json as { jobComplete?: boolean; rows?: { f?: { v?: unknown }[] }[] };
  if (j.jobComplete === false) throw new Error("bigquery job did not complete in time");
  return (j.rows ?? []).map((r) => (r.f ?? []).map((c) => (c.v == null ? "" : String(c.v))));
}

// Run one standard-SQL query in `project` and return its rows. Uses the
// synchronous jobs.query endpoint with a server-side wait, so there is no client
// polling loop; a query that outlives the wait surfaces as an error and the
// caller retries on its next refresh.
export async function bigQuery(
  project: string,
  sql: string,
  env: (k: string) => string | undefined,
): Promise<string[][]> {
  const token = await accessToken(env);
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/queries`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 25_000 }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`bigquery query failed: HTTP ${res.status}`);
  return bqRows(await res.json());
}
