import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";

import {
  buildLocalContext,
  finishRunRecording,
  recordingChildEnv,
  shipSpool,
  startRunRecording,
  sweepSpools,
} from "./test-records.ts";
import {
  createRunSpool,
  FragmentWriter,
  gunzipToText,
  listSpools,
  RECORD_SCHEMA_VERSION,
  type RunContext,
} from "@commonfabric/test-support/records";

const KEY = {
  client_email: "test-records-gh-octocat@proj.iam.gserviceaccount.com",
  private_key: "unused by the stub transport",
  token_uri: "https://oauth2.googleapis.com/token",
  cf_username: "octocat",
};

const CONTEXT: RunContext = {
  schema: RECORD_SCHEMA_VERSION,
  line: "context",
  reportId: "01SHIPTEST00000000000000",
  repo: "commontoolsinc/labs",
  commit: "d".repeat(40),
  dirty: false,
  branch: "main",
  env: "local",
  os: "darwin",
  arch: "aarch64",
  denoVersion: "2.9.4",
  startedAt: "2026-08-17T22:00:00.000Z",
};

function okFetch(
  requests: { url: string; body: Uint8Array }[],
): typeof fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body as Uint8Array });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
}

describe("test-records", () => {
  let root: string;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "test-records-owner-" });
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  });

  describe("buildLocalContext()", () => {
    it("returns this repository's commit, branch, and machine facts", async () => {
      const context = await buildLocalContext(Deno.cwd(), () => undefined);
      expect(context.repo).toBe("commontoolsinc/labs");
      expect(context.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(context.env).toBe("local");
      expect(context.denoVersion).toBe(Deno.version.deno);
      expect(context.agent).toBeUndefined();
    });

    it("carries the agent label when the variable is set", async () => {
      const context = await buildLocalContext(
        Deno.cwd(),
        (name) => name === "CF_TEST_AGENT" ? "probe-agent" : undefined,
      );
      expect(context.agent).toBe("probe-agent");
    });
  });

  describe("startRunRecording()", () => {
    it("joins an enclosing run when the records variable is set", async () => {
      const recording = await startRunRecording((name) =>
        name === "CF_TEST_RECORDS_DIR" ? "/some/spool" : undefined
      );
      expect(recording).toEqual({ mode: "join", dir: "/some/spool" });
      expect(recordingChildEnv(recording)).toEqual({});
    });

    it("is off with neither a run nor a key", async () => {
      const recording = await startRunRecording(() => undefined);
      expect(recording).toEqual({ mode: "off" });
    });

    it("owns a run when a key file is present", async () => {
      const keyPath = join(root, "key.json");
      await Deno.writeTextFile(keyPath, JSON.stringify(KEY));
      const recording = await startRunRecording((name) => {
        if (name === "CF_TEST_RECORDS_KEY_FILE") return keyPath;
        if (name === "CF_TEST_RECORDS_SPOOL_ROOT") return root;
        return undefined;
      });
      assert(recording.mode === "own");
      expect(recordingChildEnv(recording)).toEqual({
        CF_TEST_RECORDS_DIR: recording.spool.dir,
      });
      recording.spool.close();
    });
  });

  describe("shipSpool()", () => {
    it("uploads one gzipped object under the holder's prefix and deletes the spool", async () => {
      const spool = await createRunSpool(root, CONTEXT);
      const writer = FragmentWriter.open(spool.dir);
      writer?.append({
        line: "record",
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        outcome: "pass",
        durationMs: 3,
      });
      writer?.close();
      spool.close();

      const requests: { url: string; body: Uint8Array }[] = [];
      const shipped = await shipSpool(spool.dir, KEY, () => undefined, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: okFetch(requests),
      });
      expect(shipped).toBe(true);
      expect(requests.length).toBe(1);
      const bodyText = new TextDecoder().decode(requests[0]!.body);
      expect(bodyText).toContain(
        '"name":"labs/test-records/submissions/local/octocat/' +
          'v1/2026/08/17/01SHIPTEST00000000000000-main.ndjson"',
      );
      expect(await listSpools(root)).toEqual([]);
    });

    it("leaves the spool in place when the create fails", async () => {
      const spool = await createRunSpool(root, CONTEXT);
      spool.close();
      const shipped = await shipSpool(spool.dir, KEY, () => undefined, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: (() =>
          Promise.resolve(
            new Response("denied", { status: 403 }),
          )) as typeof fetch,
      });
      expect(shipped).toBe(false);
      expect((await listSpools(root)).length).toBe(1);
    });
  });

  describe("sweepSpools()", () => {
    it("ships released spools and skips the one it owns", async () => {
      const orphan = await createRunSpool(root, {
        ...CONTEXT,
        reportId: "01ORPHAN0000000000000000",
      });
      orphan.close();
      const own = await createRunSpool(root, {
        ...CONTEXT,
        reportId: "01OWNED00000000000000000",
      });

      const requests: { url: string; body: Uint8Array }[] = [];
      await sweepSpools(root, KEY, own.dir, () => undefined, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: okFetch(requests),
      });
      expect(requests.length).toBe(1);
      expect(await listSpools(root)).toEqual([own.dir]);
      own.close();
    });
  });

  describe("finishRunRecording()", () => {
    it("ships the owned spool and sweeps the root", async () => {
      const keyPath = join(root, "key.json");
      await Deno.writeTextFile(keyPath, JSON.stringify(KEY));
      const env = (name: string) => {
        if (name === "CF_TEST_RECORDS_KEY_FILE") return keyPath;
        if (name === "CF_TEST_RECORDS_SPOOL_ROOT") return root;
        return undefined;
      };
      const recording = await startRunRecording(env);
      assert(recording.mode === "own");

      const requests: { url: string; body: Uint8Array }[] = [];
      await finishRunRecording(recording, env, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: okFetch(requests),
      });
      expect(requests.length).toBe(1);
      const gzipStart = findGzipStart(requests[0]!.body);
      const ndjson = await gunzipToText(requests[0]!.body.slice(
        gzipStart.start,
        gzipStart.end,
      ));
      const context = JSON.parse(ndjson.trimEnd().split("\n")[0]!);
      expect(context.line).toBe("context");
      expect(context.env).toBe("local");
      expect(await listSpools(root)).toEqual([]);
    });
  });
});

/** Byte offsets of the multipart payload between headers and tail. */
function findGzipStart(bytes: Uint8Array): { start: number; end: number } {
  const pattern = new TextEncoder().encode("\r\n\r\n");
  const matches: number[] = [];
  outer: for (let i = 0; i <= bytes.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    matches.push(i);
  }
  const tail = new TextEncoder().encode("\r\n--");
  let end = -1;
  outer: for (let i = bytes.length - tail.length; i >= 0; i--) {
    for (let j = 0; j < tail.length; j++) {
      if (bytes[i + j] !== tail[j]) continue outer;
    }
    end = i;
    break;
  }
  return { start: matches[1]! + 4, end };
}
