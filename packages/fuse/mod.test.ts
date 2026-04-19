import { assertEquals } from "@std/assert";
import {
  DEFAULT_CFC_XATTR_NAMESPACE,
  defaultCfcWritebackStatePath,
  parseCfcXattrNamespace,
} from "./mod.ts";

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
