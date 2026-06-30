// Integration tests for the state-inspector remote dump endpoint.
//
// env is parsed once at module load, so we set the MEMORY_DUMP_* vars and a
// temp MEMORY_DIR BEFORE dynamically importing the router. Every static import
// here is env-free, so env.ts first evaluates inside the dynamic import below.

import { afterAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { Database } from "@db/sqlite";
import * as Path from "@std/path";

const SQLITE_MAGIC = "SQLite format 3\0";
const DUMP_BASE = "/api/storage/memory/dump";
const SPACE = "did:key:z6MkDumpEndpointTestSpace000000000000000000000000";

// Fabricate a temp MEMORY_DIR with a single, real (tiny) space store.
const tmp = await Deno.makeTempDir({ prefix: "cf-dump-it-" });
const engineDir = Path.join(tmp, "engine-v3");
await Deno.mkdir(engineDir, { recursive: true });
const storePath = Path.fromFileUrl(
  new URL(
    `./${encodeURIComponent(SPACE)}.sqlite`,
    Path.toFileUrl(`${engineDir}/`),
  ),
);
{
  const db = new Database(storePath);
  db.exec("CREATE TABLE probe (n INTEGER)");
  db.exec("INSERT INTO probe (n) VALUES (42)");
  db.close();
}

const allowed = await Identity.fromPassphrase("dump endpoint allowed signer");
const stranger = await Identity.fromPassphrase("dump endpoint stranger signer");

Deno.env.set("MEMORY_DIR", Path.toFileUrl(`${tmp}/`).href);
Deno.env.set("MEMORY_DUMP_ENABLED", "true");
Deno.env.set("MEMORY_DUMP_DIDS", allowed.did());

const { createTestApp } = await import("@/lib/create-app.ts");
const { default: dumpRouter } = await import("./memory-dump.index.ts");
const app = createTestApp(dumpRouter);

function sign(path: string, signer: Identity): Promise<Headers> {
  return signFirstPartyHttpRequest({
    url: new URL(path, "http://localhost"),
    method: "GET",
    signer,
  });
}

afterAll(async () => {
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
});

describe("memory dump endpoint", () => {
  it("rejects unsigned requests with 401", async () => {
    const res = await app.request(DUMP_BASE);
    await res.body?.cancel();
    expect(res.status).toBe(401);
  });

  it("rejects a signed request from a non-allowlisted DID with 403", async () => {
    const res = await app.request(DUMP_BASE, {
      headers: await sign(DUMP_BASE, stranger),
    });
    await res.body?.cancel();
    expect(res.status).toBe(403);
  });

  it("lists spaces for an allowlisted DID", async () => {
    const res = await app.request(DUMP_BASE, {
      headers: await sign(DUMP_BASE, allowed),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      spaces: { space: string; sizeBytes: number }[];
    };
    const found = body.spaces.find((s) => s.space === SPACE);
    expect(found).toBeDefined();
    expect(found!.sizeBytes).toBeGreaterThan(0);
  });

  it("dumps a consistent SQLite snapshot for an allowlisted DID", async () => {
    const path = `${DUMP_BASE}/${encodeURIComponent(SPACE)}`;
    const res = await app.request(path, { headers: await sign(path, allowed) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Valid SQLite file header.
    expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe(SQLITE_MAGIC);

    // And it round-trips: the snapshot opens and carries our probe row.
    const out = await Deno.makeTempFile({ suffix: ".sqlite" });
    try {
      await Deno.writeFile(out, bytes);
      const db = new Database(out, { readonly: true });
      try {
        const row = db.prepare("SELECT n FROM probe").get<{ n: number }>();
        expect(row?.n).toBe(42);
      } finally {
        db.close();
      }
    } finally {
      await Deno.remove(out).catch(() => {});
    }
  });

  it("returns 404 for an unknown space", async () => {
    const path = `${DUMP_BASE}/${encodeURIComponent("did:key:zNope")}`;
    const res = await app.request(path, { headers: await sign(path, allowed) });
    await res.body?.cancel();
    expect(res.status).toBe(404);
  });

  it("blocks path traversal in the space id with 404", async () => {
    const path = `${DUMP_BASE}/${encodeURIComponent("../../../etc/passwd")}`;
    const res = await app.request(path, { headers: await sign(path, allowed) });
    await res.body?.cancel();
    expect(res.status).toBe(404);
  });
});
