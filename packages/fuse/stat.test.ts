import { assertEquals } from "@std/assert";
import { FILE_MODE_RWX } from "./platform.ts";
import { buildNodeStat, getMountOwnership } from "./stat.ts";
import type { FsNode } from "./types.ts";

Deno.test("getMountOwnership uses the current process ids when available", () => {
  assertEquals(
    getMountOwnership({
      uid: () => 501,
      gid: () => 20,
    }),
    { uid: 501, gid: 20 },
  );
});

Deno.test("getMountOwnership falls back to root ids when unavailable", () => {
  assertEquals(getMountOwnership({}), { uid: 0, gid: 0 });
});

Deno.test("getMountOwnership falls back when uid/gid probes throw", () => {
  assertEquals(
    getMountOwnership({
      uid: () => {
        throw new Error("uid unavailable");
      },
      gid: () => {
        throw new Error("gid unavailable");
      },
    }),
    { uid: 0, gid: 0 },
  );
});

Deno.test("buildNodeStat assigns mounted handler files to the current user", () => {
  const script = new TextEncoder().encode("#!/bin/sh\n");
  const node: FsNode = {
    kind: "callable",
    callableKind: "handler",
    cellKey: "addItem",
    cellProp: "result",
    script,
  };

  assertEquals(
    buildNodeStat(node, 7n, {
      ownership: { uid: 501, gid: 20 },
    }),
    {
      ino: 7n,
      mode: FILE_MODE_RWX,
      nlink: 1,
      size: script.length,
      uid: 501,
      gid: 20,
    },
  );
});
