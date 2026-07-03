// Drives `cf inspect … --remote` in-process against a stubbed fetch, so the CLI
// remote plumbing (base-url resolution, CF1 signing, remote DID resolution,
// fetch+cache, and the spaces/pull/summary/converge actions) is actually
// exercised — no live server needed. `main.parse` re-throws action errors, so
// error paths are asserted with assertRejects.

import { afterAll, afterEach, beforeAll, describe, it } from "@std/testing/bdd";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Database } from "@db/sqlite";
import { Identity } from "@commonfabric/identity";
import { defaultCacheDir } from "@commonfabric/state-inspector";
import { inspect } from "../commands/inspect.ts";

const DUMP_BASE = "/api/storage/memory/dump";
const BASE = "http://cli-remote-test.invalid:9999";
const DID_A = "did:key:z6MkCliRemoteTestSpaceAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DID_B = "did:key:z6MkCliRemoteTestSpaceBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Minimal valid memory-v2 space DB (schema mirrors state-inspector/test/cli.test.ts).
const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 1, 'active');
`;

let dbBytes: Uint8Array<ArrayBuffer>;
let keyPath: string;
let tmpRoot: string;
const realFetch = globalThis.fetch;
const prevIdentity = Deno.env.get("CF_IDENTITY");
const prevApiUrl = Deno.env.get("CF_API_URL");

async function buildDbBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await Deno.makeTempDir({ prefix: "cli-remote-seed-" });
  const path = `${dir}/space.sqlite`;
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (1, 'session:did:key:zX:u', 1, '{"reads":{"confirmed":[],"pending":[]}}', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES ('of:a', 1, 0, 'set', ?, 1)`,
  ).run(JSON.stringify({ value: { n: 1 } }));
  db.close();
  const bytes = await Deno.readFile(path);
  await Deno.remove(dir, { recursive: true });
  return bytes;
}

interface StubOpts {
  status?: number;
  spaces?: { space: string; sizeBytes: number; mtimeMs: number }[];
}
function stubFetch(opts: StubOpts = {}): void {
  const spaces = opts.spaces ??
    [{ space: DID_A, sizeBytes: dbBytes.length, mtimeMs: 1 }];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (opts.status && opts.status !== 200) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "denied" }), {
          status: opts.status,
        }),
      );
    }
    if (url.pathname === DUMP_BASE) {
      return Promise.resolve(
        new Response(JSON.stringify({ spaces }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.pathname.startsWith(`${DUMP_BASE}/`)) {
      return Promise.resolve(new Response(dbBytes, { status: 200 }));
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
}

/** Run a subcommand, capturing stdout. */
async function run(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await inspect.parse(argv);
    return lines.join("\n");
  } finally {
    console.log = orig;
  }
}

async function clearCache(): Promise<void> {
  await Deno.remove(defaultCacheDir(BASE), { recursive: true }).catch(() => {});
}

beforeAll(async () => {
  dbBytes = await buildDbBytes();
  tmpRoot = await Deno.makeTempDir({ prefix: "cli-remote-key-" });
  keyPath = `${tmpRoot}/id.key`;
  await Deno.writeFile(keyPath, await Identity.generatePkcs8());
  Deno.env.set("CF_IDENTITY", keyPath);
  Deno.env.delete("CF_API_URL");
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await clearCache();
});

afterAll(async () => {
  if (prevIdentity === undefined) Deno.env.delete("CF_IDENTITY");
  else Deno.env.set("CF_IDENTITY", prevIdentity);
  if (prevApiUrl === undefined) Deno.env.delete("CF_API_URL");
  else Deno.env.set("CF_API_URL", prevApiUrl);
  await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
});

describe("cf inspect --remote", () => {
  it("spaces --remote lists what the server exposes", async () => {
    stubFetch({ spaces: [{ space: DID_A, sizeBytes: 10, mtimeMs: 1 }] });
    const out = await run(["spaces", "--remote", BASE, "--json"]);
    const parsed = JSON.parse(out);
    assertEquals(parsed.remote, BASE);
    assertEquals(parsed.spaces[0].space, DID_A);
  });

  it("bare --remote falls back to CF_API_URL", async () => {
    stubFetch();
    Deno.env.set("CF_API_URL", BASE);
    try {
      const out = await run(["spaces", "--remote", "--json"]);
      assertEquals(JSON.parse(out).remote, BASE);
    } finally {
      Deno.env.delete("CF_API_URL");
    }
  });

  it("bare --remote with no CF_API_URL errors", async () => {
    stubFetch();
    await assertRejects(
      () => run(["spaces", "--remote", "--json"]),
      Error,
      "CF_API_URL",
    );
  });

  it("pull <did> caches the snapshot with a literal-DID filename", async () => {
    stubFetch();
    const out = await run(["pull", DID_A, "--remote", BASE, "--json"]);
    const parsed = JSON.parse(out);
    assertEquals(parsed.pulled[0].did, DID_A);
    assertStringIncludes(parsed.pulled[0].path, `${DID_A}.sqlite`);
    assertEquals(parsed.pulled[0].path.includes("%3A"), false);
  });

  it("pull --all pulls every listed space", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    const out = await run(["pull", "--all", "--remote", BASE, "--json"]);
    const dids = JSON.parse(out).pulled.map((p: { did: string }) => p.did);
    assertEquals(dids.sort(), [DID_A, DID_B].sort());
  });

  it("pull without --remote is an error", async () => {
    await assertRejects(
      () => run(["pull", DID_A, "--json"]),
      Error,
      "requires --remote",
    );
  });

  it("summary --remote fetches, caches, and inspects a full DID", async () => {
    stubFetch();
    const out = await run(["summary", DID_A, "--remote", BASE, "--json"]);
    const s = JSON.parse(out);
    assertEquals(s.commits, 1);
    assertEquals(s.entities, 1);
  });

  it("resolveRemoteDid: a unique prefix resolves via the remote list", async () => {
    stubFetch({ spaces: [{ space: DID_A, sizeBytes: 10, mtimeMs: 1 }] });
    const out = await run([
      "summary",
      "z6MkCliRemoteTestSpaceA",
      "--remote",
      BASE,
      "--json",
    ]);
    assertEquals(JSON.parse(out).entities, 1);
  });

  it("resolveRemoteDid: a did:-prefixed PREFIX resolves like any prefix", async () => {
    // Regression: a partial DID (`did:key:z6Mk…` copied short) used to be sent
    // verbatim and 404 instead of prefix-resolving against the remote listing.
    stubFetch({ spaces: [{ space: DID_A, sizeBytes: 10, mtimeMs: 1 }] });
    const out = await run([
      "summary",
      DID_A.slice(0, 20), // "did:key:z6MkCliRemot"
      "--remote",
      BASE,
      "--json",
    ]);
    assertEquals(JSON.parse(out).entities, 1);
  });

  it("resolveRemoteDid: an ambiguous token errors", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    await assertRejects(
      () =>
        run(["summary", "z6MkCliRemoteTestSpace", "--remote", BASE, "--json"]),
      Error,
      "ambiguous",
    );
  });

  it("a 401 from the server surfaces an actionable error", async () => {
    stubFetch({ status: 401 });
    await assertRejects(
      () => run(["spaces", "--remote", BASE, "--json"]),
      Error,
      "CF_IDENTITY",
    );
  });

  it("converge --spaces over --remote reconstructs across fetched DBs", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    const out = await run([
      "converge",
      "of:a",
      "--spaces",
      `${DID_A},${DID_B}`,
      "--remote",
      BASE,
      "--json",
    ]);
    assertEquals(JSON.parse(out).id, "of:a");
  });

  it("converge --all over --remote uses the remote listing", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    const out = await run([
      "converge",
      "of:a",
      "--all",
      "--remote",
      BASE,
      "--json",
    ]);
    assertEquals(JSON.parse(out).id, "of:a");
  });

  it("converge --remote with neither --all nor --spaces errors", async () => {
    stubFetch();
    await assertRejects(
      () => run(["converge", "of:a", "--remote", BASE, "--json"]),
      Error,
      "--all or --spaces",
    );
  });

  it("resolveRemoteDid: a token matching nothing errors", async () => {
    stubFetch({ spaces: [{ space: DID_A, sizeBytes: 10, mtimeMs: 1 }] });
    await assertRejects(
      () => run(["summary", "zNoSuchSpaceXYZ", "--remote", BASE, "--json"]),
      Error,
      "no remote space matches",
    );
  });

  it("no CF_IDENTITY sends an unsigned request (server would 401)", async () => {
    stubFetch();
    Deno.env.delete("CF_IDENTITY");
    try {
      // Stub accepts it; the point is remoteSigner returns undefined and the
      // request still goes out (real server replies 401 — see 401 test above).
      const out = await run(["spaces", "--remote", BASE, "--json"]);
      assertEquals(JSON.parse(out).remote, BASE);
    } finally {
      Deno.env.set("CF_IDENTITY", keyPath);
    }
  });

  it("without --remote, a command opens a local DB by path", async () => {
    const dir = await Deno.makeTempDir({ prefix: "cli-remote-local-" });
    const path = `${dir}/space.sqlite`;
    try {
      await Deno.writeFile(path, dbBytes);
      const out = await run(["summary", path, "--json"]);
      assertEquals(JSON.parse(out).entities, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
