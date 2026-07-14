import { assert, assertEquals, assertThrows } from "@std/assert";
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
import {
  ATTRCACHE_TIMEOUT_MAX_SECONDS,
  buildMountFuseArgs,
  DEFAULT_FUSE_T_ATTRCACHE_TIMEOUT_SECONDS,
  parseAttrcacheTimeoutSeconds,
} from "./mount-options.ts";
import darwinPlatform, { libfusePaths } from "./platform-darwin.ts";
import linuxPlatform from "./platform-linux.ts";
import { EACCES, EINVAL, EROFS } from "./platform.ts";

function env(values: Record<string, string | undefined>) {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}

function assertAppearsBefore(
  source: string,
  earlier: string,
  later: string,
  label = "source order",
): void {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert(earlierIndex >= 0, `${label}: missing source fragment: ${earlier}`);
  assert(laterIndex >= 0, `${label}: missing source fragment: ${later}`);
  assert(
    earlierIndex < laterIndex,
    `expected ${earlier} to appear before ${later}`,
  );
}

function assertAppearsBeforeAfter(
  source: string,
  after: string,
  earlier: string,
  later: string,
  label: string,
): void {
  const start = source.indexOf(after);
  assert(start >= 0, `${label}: missing section marker: ${after}`);
  assertAppearsBefore(source.slice(start), earlier, later, label);
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

Deno.test("mutating callbacks reject disconnected writes before optimistic mutation", async () => {
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));
  const mutationGuards = [
    [
      "open callback",
      'logOp("open"',
      "if (failIfDisconnectedWrite(req)) return;",
      "const fh = handles.open(",
    ],
    [
      "write callback",
      'logOp("write"',
      "const errno = disconnectedWriteErrno(bridge);",
      "!handles.write(fh, data, off)",
    ],
    [
      "flushHandle",
      "async function flushHandle",
      "const disconnectedErrno = disconnectedWriteErrno(bridge);",
      'if (writeTarget?.kind === "handler")',
    ],
    [
      "flush callback",
      'logOp("flush"',
      "const errno = disconnectedWriteErrno(bridge);",
      "fuse.symbols.fuse_reply_err(req, 0);\n      console.log(`[write-trace] flush-fire fh=${fh}`);",
    ],
    [
      "release callback",
      'logOp("release"',
      "const errno = disconnectedWriteErrno(bridge);",
      "fuse.symbols.fuse_reply_err(req, 0);\n        let flushPromise",
    ],
    [
      "setattr",
      'logOp("setattr"',
      "if ((sizeChange || metadataChange) && failIfDisconnectedWrite(req))",
      "applyPreparedExistingWrite",
    ],
    [
      "setxattr",
      'logOp("setxattr"',
      "if (failIfDisconnectedWrite(req)) return;\n      const name = readCString(namePtr);",
      "cfcWritebacks.setPreparedXattr",
    ],
    [
      "removexattr",
      'logOp("removexattr"',
      "if (failIfDisconnectedWrite(req)) return;\n      const name = readCString(namePtr);",
      "cfcWritebacks.deleteAllForIno",
    ],
    [
      "create",
      "const parentPath = bridge.resolveWritePath(parent);",
      'if (failIfDisconnectedWrite(req)) return;\n      if (!authorizeCreateCfcWrite(parent, "create", name))',
      "tree.addFile(parent, name",
    ],
    [
      "mkdir",
      'logOp("mkdir"',
      'if (failIfDisconnectedWrite(req)) return;\n      if (!authorizeCreateCfcWrite(parent, "mkdir", name))',
      "tree.addDir(parent, name",
    ],
    [
      "unlink",
      "parentPath ??= bridge.resolveWritePath(parent);",
      'if (failIfDisconnectedWrite(req)) return;\n      authorization ??= authorizeNamespaceCfcWrite(parent, "unlink", name);',
      "tree.removeChild(parent, name)",
    ],
    [
      "rmdir",
      'logOp("rmdir"',
      'if (failIfDisconnectedWrite(req)) return;\n      authorization ??= authorizeNamespaceCfcWrite(parent, "rmdir", name);',
      "tree.removeChild(parent, name)",
    ],
    [
      "rename",
      'logOp("rename"',
      "if (failIfDisconnectedWrite(req)) return;\n      renameAuthorization ??= authorizeRenameCfcWrite",
      "tree.rename(oldParent, oldName, newParent, newName)",
    ],
    [
      "symlink",
      "const symlinkCb",
      "if (failIfDisconnectedWrite(req)) return;\n\n      let authorization = undefined",
      "tree.addSymlink(parent, name, target)",
    ],
  ] as const;

  for (const [label, marker, guard, mutation] of mutationGuards) {
    assertAppearsBeforeAfter(source, marker, guard, mutation, label);
  }
});

Deno.test("namespace write failures use shared outage accounting", async () => {
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));

  for (
    const operation of [
      "create",
      "mkdir",
      "unlink",
      "rmdir",
      "rename",
      "symlink",
    ]
  ) {
    assert(
      source.includes(
        `recordAsyncWriteFailure(\"${operation} write error\", e);`,
      ),
      `missing shared outage accounting for ${operation}`,
    );
  }
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

Deno.test("platform ENOTSUP matches host errno values", () => {
  assertEquals(darwinPlatform.ENOTSUP, 45);
  assertEquals(linuxPlatform.ENOTSUP, 95);
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

Deno.test("mount fuse args apply allow_other on Linux only", () => {
  assertEquals(
    buildMountFuseArgs({
      os: "linux",
      provider: "linux-libfuse",
      allowOther: true,
      cfcWritebackXattrs: false,
      noattrcache: false,
    }),
    ["fuse_ct", "-o", "allow_other", "-o", "default_permissions"],
  );
  assertEquals(
    buildMountFuseArgs({
      os: "linux",
      provider: "linux-libfuse",
      allowOther: true,
      cfcWritebackXattrs: true,
      noattrcache: false,
    }),
    ["fuse_ct", "-o", "allow_other"],
  );
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: true,
      cfcWritebackXattrs: false,
      noattrcache: false,
      attrcacheTimeoutSeconds: 0,
    }),
    ["fuse_ct"],
  );
});

Deno.test("mount fuse args apply noattrcache to FUSE-T mounts only", () => {
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: true,
    }),
    ["fuse_ct", "-o", "noattrcache"],
  );
  for (
    const [os, provider] of [
      ["linux", "linux-libfuse"],
      ["darwin", "macfuse"],
      ["darwin", "unknown"],
    ] as const
  ) {
    assertEquals(
      buildMountFuseArgs({
        os,
        provider,
        allowOther: false,
        cfcWritebackXattrs: false,
        noattrcache: true,
      }),
      ["fuse_ct"],
    );
  }
});

Deno.test("FUSE-T mounts default to a one-second attrcache-timeout", () => {
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
    }),
    ["fuse_ct", "-o", "attrcache-timeout=1"],
  );
  assertEquals(DEFAULT_FUSE_T_ATTRCACHE_TIMEOUT_SECONDS, 1);
  // Explicit zero restores the NFS client's default caching.
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
      attrcacheTimeoutSeconds: 0,
    }),
    ["fuse_ct"],
  );
  // noattrcache suppresses the timeout default.
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: true,
      attrcacheTimeoutSeconds: 5,
    }),
    ["fuse_ct", "-o", "noattrcache"],
  );
  // macFUSE rejects the option, so no default is applied there, and an
  // unresolved provider gets no default either.
  for (const provider of ["macfuse", "unknown"] as const) {
    assertEquals(
      buildMountFuseArgs({
        os: "darwin",
        provider,
        allowOther: false,
        cfcWritebackXattrs: false,
        noattrcache: false,
      }),
      ["fuse_ct"],
    );
  }
});

Deno.test("mount fuse args apply attrcache-timeout to FUSE-T mounts only", () => {
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
      attrcacheTimeoutSeconds: 30,
    }),
    ["fuse_ct", "-o", "attrcache-timeout=30"],
  );
  assertEquals(
    buildMountFuseArgs({
      os: "linux",
      provider: "linux-libfuse",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
      attrcacheTimeoutSeconds: 30,
    }),
    ["fuse_ct"],
  );
});

Deno.test("attrcache-timeout parses whole seconds within bounds", () => {
  assertEquals(parseAttrcacheTimeoutSeconds(""), undefined);
  assertEquals(parseAttrcacheTimeoutSeconds("1"), 1);
  assertEquals(parseAttrcacheTimeoutSeconds("30"), 30);
  assertEquals(
    parseAttrcacheTimeoutSeconds(String(ATTRCACHE_TIMEOUT_MAX_SECONDS)),
    ATTRCACHE_TIMEOUT_MAX_SECONDS,
  );
  assertEquals(parseAttrcacheTimeoutSeconds("0"), 0);
  assertThrows(() => parseAttrcacheTimeoutSeconds("-1"));
  assertThrows(() => parseAttrcacheTimeoutSeconds("1.5"));
  assertThrows(() => parseAttrcacheTimeoutSeconds("abc"));
  assertThrows(() =>
    parseAttrcacheTimeoutSeconds(String(ATTRCACHE_TIMEOUT_MAX_SECONDS + 1))
  );
  assertThrows(() => parseAttrcacheTimeoutSeconds("1e21"));
});

Deno.test("libfuse search includes the FUSE-T per-user install location", () => {
  assertEquals(
    libfusePaths(env({ HOME: "/Users/alice" })),
    [
      "/usr/local/lib/libfuse-t.dylib",
      "/Users/alice/.fuse-t/usr/local/lib/libfuse-t.dylib",
      "/usr/local/lib/libfuse.2.dylib",
    ],
  );
  assertEquals(
    libfusePaths(env({})),
    [
      "/usr/local/lib/libfuse-t.dylib",
      "/usr/local/lib/libfuse.2.dylib",
    ],
  );
});
