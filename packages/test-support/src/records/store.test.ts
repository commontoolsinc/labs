import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";

import { createObject, gunzipToText, gzipText } from "./store.ts";

function fetchStub(
  status: number,
  onRequest?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    onRequest?.(String(input), init ?? {});
    return Promise.resolve(
      new Response(status === 200 ? "{}" : "denied", { status }),
    );
  }) as typeof fetch;
}

describe("store", () => {
  describe("gzipText()", () => {
    it("round-trips through gunzipToText()", async () => {
      const text = '{"line":"context"}\n{"line":"record"}\n';
      expect(await gunzipToText(await gzipText(text))).toBe(text);
    });
  });

  describe("createObject()", () => {
    it("returns created and sends a guarded multipart create", async () => {
      let seenUrl = "";
      let seenBody: Uint8Array | undefined;
      let seenHeaders: Record<string, string> = {};
      const result = await createObject({
        bucket: "cf-ci-metadata",
        name: "labs/test-records/submissions/ci/v1/2026/08/17/x.ndjson",
        body: new TextEncoder().encode("payload-bytes"),
        token: "token-123",
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
        fetch: fetchStub(200, (url, init) => {
          seenUrl = url;
          seenBody = init.body as Uint8Array;
          seenHeaders = init.headers as Record<string, string>;
        }),
      });
      expect(result).toBe("created");
      expect(seenUrl).toContain("/b/cf-ci-metadata/o");
      expect(seenUrl).toContain("uploadType=multipart");
      expect(seenUrl).toContain("ifGenerationMatch=0");
      expect(seenHeaders.authorization).toBe("Bearer token-123");
      assert(seenBody);
      const bodyText = new TextDecoder().decode(seenBody);
      expect(bodyText).toContain('"contentEncoding":"gzip"');
      expect(bodyText).toContain(
        '"name":"labs/test-records/submissions/ci/v1/2026/08/17/x.ndjson"',
      );
      expect(bodyText).toContain("payload-bytes");
    });

    it("returns exists on a precondition failure", async () => {
      const result = await createObject({
        bucket: "b",
        name: "n",
        body: new Uint8Array(0),
        token: "t",
        fetch: fetchStub(412),
      });
      expect(result).toBe("exists");
    });

    it("throws on any other error status", async () => {
      await expect(createObject({
        bucket: "b",
        name: "n",
        body: new Uint8Array(0),
        token: "t",
        fetch: fetchStub(403),
      })).rejects.toThrow("HTTP 403");
    });
  });
});
