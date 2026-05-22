import { assertEquals } from "@std/assert";
import {
  appendDecodedJsonPath,
  bufferForNoHandleTruncate,
  cfcWritebackXattrResultErrno,
  decodeFuseNamespaceName,
  DEFAULT_CFC_XATTR_NAMESPACE,
  defaultCfcWritebackStatePath,
  disconnectedWriteErrno,
  isConnectionWriteFailure,
  parseCfcXattrNamespace,
  rootSpaceLookupNames,
  sourceRelPathToTreeSegments,
  writeUnavailableErrno,
} from "./mod.ts";
import { EACCES, EINVAL, EROFS } from "./platform.ts";

function env(values: Record<string, string | undefined>) {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}

Deno.test("CFC xattr namespace defaults to both and rejects unknown values", () => {
  assertEquals(DEFAULT_CFC_XATTR_NAMESPACE, "both");
  assertEquals(parseCfcXattrNamespace("trusted"), "trusted");
  assertEquals(parseCfcXattrNamespace("compat"), "compat");
  assertEquals(parseCfcXattrNamespace("both"), "both");
  assertEquals(parseCfcXattrNamespace("bogus"), undefined);
});

Deno.test("default CFC writeback state path avoids /tmp fallback", () => {
  assertEquals(
    defaultCfcWritebackStatePath(
      "/mnt/cf mount",
      env({
        CF_CFC_WRITEBACK_STATE_DIR: "/explicit/state",
        XDG_STATE_HOME: "/xdg/state",
        HOME: "/home/alice",
        TMPDIR: "/tmp/ignored",
      }),
    ),
    "/explicit/state/cfc-writeback-_2Fmnt_2Fcf_20mount.json",
  );

  assertEquals(
    defaultCfcWritebackStatePath(
      "/mnt/cf",
      env({
        XDG_STATE_HOME: "/xdg/state",
        HOME: "/home/alice",
        TMPDIR: "/tmp/ignored",
      }),
    ),
    "/xdg/state/commonfabric-fuse/cfc-writeback-_2Fmnt_2Fcf.json",
  );

  assertEquals(
    defaultCfcWritebackStatePath(
      "/mnt/cf",
      env({
        HOME: "/home/alice",
        TMPDIR: "/tmp/ignored",
      }),
    ),
    "/home/alice/.cache/commonfabric-fuse/cfc-writeback-_2Fmnt_2Fcf.json",
  );
});

Deno.test("FUSE namespace writeback decodes path component names", () => {
  assertEquals(decodeFuseNamespaceName("of%3Aentity"), "of:entity");
  assertEquals(
    appendDecodedJsonPath(["items"], "of%3Aentity"),
    ["items", "of:entity"],
  );
});

Deno.test("source writeback re-encodes decoded source relpaths for tree lookup", () => {
  assertEquals(
    sourceRelPathToTreeSegments("src/has:colon.tsx"),
    ["src", "has%3Acolon.tsx"],
  );
});

Deno.test("no-handle truncate opens only the bounded target prefix", () => {
  const content = new Uint8Array([1, 2, 3, 4, 5]);
  assertEquals([...bufferForNoHandleTruncate(content, 2)], [1, 2]);
  assertEquals(bufferForNoHandleTruncate(content, 0).length, 0);
});

Deno.test("writeUnavailableErrno reports read-only filesystem while disconnected", () => {
  assertEquals(writeUnavailableErrno({ disconnected: true }), EROFS);
  assertEquals(writeUnavailableErrno({ disconnected: false }), EACCES);
  assertEquals(writeUnavailableErrno(null), EACCES);
});

Deno.test("disconnectedWriteErrno only rejects degraded writes", () => {
  assertEquals(disconnectedWriteErrno({ disconnected: true }), EROFS);
  assertEquals(disconnectedWriteErrno({ disconnected: false }), null);
  assertEquals(disconnectedWriteErrno(undefined), null);
});

Deno.test("connection write failure classifier recognizes backend outages", () => {
  assertEquals(
    isConnectionWriteFailure(new Error("ConnectionError: transport closed")),
    true,
  );
  assertEquals(
    isConnectionWriteFailure(
      "failed to connect to WebSocket: tcp connect error",
    ),
    true,
  );
  assertEquals(isConnectionWriteFailure("connection refused"), true);
  assertEquals(
    isConnectionWriteFailure(new Error("schema validation failed")),
    false,
  );
});

Deno.test("CFC writeback xattr errno policy distinguishes unsupported and malformed payloads", () => {
  const enotsup = 95;

  assertEquals(cfcWritebackXattrResultErrno({ ok: true }, { enotsup }), 0);
  assertEquals(
    cfcWritebackXattrResultErrno(
      { ok: false, reason: "unsupported writeback xattr" },
      { enotsup },
    ),
    enotsup,
  );
  assertEquals(
    cfcWritebackXattrResultErrno(
      { ok: false, reason: "invalid prepare metadata" },
      { enotsup },
    ),
    EINVAL,
  );
  assertEquals(
    cfcWritebackXattrResultErrno(
      { ok: false, reason: "invalid finalize metadata" },
      { enotsup },
    ),
    EINVAL,
  );
});

Deno.test("root space lookup decodes request names and replies with canonical names", () => {
  assertEquals(rootSpaceLookupNames("did%3Akey%3AzSpace"), {
    spaceName: "did:key:zSpace",
    directoryName: "did%3Akey%3AzSpace",
  });
  assertEquals(rootSpaceLookupNames("home"), {
    spaceName: "home",
    directoryName: "home",
  });
});
