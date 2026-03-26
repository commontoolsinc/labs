// verify-structs.test.ts — Compile and run verify-structs.c to validate
// that the hardcoded struct offsets in platform-linux.ts are correct.
//
// This test only runs on Linux where libfuse3 headers are available.

import { assertEquals } from "@std/assert";

Deno.test({
  name: "Linux struct offsets match C headers",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const dir = new URL(".", import.meta.url).pathname;
    const src = `${dir}verify-structs.c`;
    const bin = `${dir}verify-structs`;

    // Get FUSE3 cflags
    const pkgConfig = new Deno.Command("pkg-config", {
      args: ["--cflags", "fuse3"],
      stdout: "piped",
      stderr: "piped",
    });
    const pkgOut = await pkgConfig.output();
    if (!pkgOut.success) {
      throw new Error(
        `pkg-config failed: ${new TextDecoder().decode(pkgOut.stderr)}`,
      );
    }
    const cflags = new TextDecoder()
      .decode(pkgOut.stdout)
      .trim()
      .split(/\s+/);

    // Compile
    const compile = new Deno.Command("gcc", {
      args: ["-o", bin, src, ...cflags],
      stderr: "piped",
    });
    const compileResult = await compile.output();
    if (!compileResult.success) {
      throw new Error(
        `gcc failed: ${new TextDecoder().decode(compileResult.stderr)}`,
      );
    }

    // Run and check exit status
    const run = new Deno.Command(bin, { stdout: "piped", stderr: "piped" });
    const runResult = await run.output();
    if (!runResult.success) {
      throw new Error(
        `verify-structs exited with code ${runResult.code}: ${
          new TextDecoder().decode(runResult.stderr)
        }`,
      );
    }
    const output = new TextDecoder().decode(runResult.stdout);

    // Parse key=value pairs
    const values = new Map<string, number>();
    for (const line of output.trim().split("\n")) {
      const [key, val] = line.split("=");
      values.set(key, parseInt(val, 10));
    }

    // Import the platform-linux values to compare
    const linux = await import("./platform-linux.ts");
    const p = linux.default;

    // struct stat
    assertEquals(values.get("stat_size"), p.STAT_SIZE, "STAT_SIZE mismatch");
    assertEquals(
      values.get("stat_st_size"),
      p.STAT_ST_SIZE_OFFSET,
      "STAT_ST_SIZE_OFFSET mismatch",
    );

    // fuse_entry_param
    assertEquals(
      values.get("entry_param_size"),
      p.ENTRY_PARAM_SIZE,
      "ENTRY_PARAM_SIZE mismatch",
    );

    // fuse_file_info
    assertEquals(
      values.get("file_info_size"),
      p.FUSE_FILE_INFO_SIZE,
      "FUSE_FILE_INFO_SIZE mismatch",
    );
    assertEquals(
      values.get("file_info_fh"),
      16, // FH_OFFSET in platform-linux.ts
      "fuse_file_info fh offset mismatch",
    );

    // fuse_args
    assertEquals(
      values.get("fuse_args_size"),
      p.FUSE_ARGS_STRUCT_SIZE,
      "FUSE_ARGS_STRUCT_SIZE mismatch",
    );

    // fuse_lowlevel_ops — verify key offsets
    const opsOffsets = p.OPS_OFFSETS;
    for (
      const [opName, expectedOffset] of Object.entries(opsOffsets)
    ) {
      const key = `ops_${opName}`;
      const actual = values.get(key);
      if (actual !== undefined) {
        assertEquals(actual, expectedOffset, `OPS_OFFSETS.${opName} mismatch`);
      }
    }

    // Verify ops struct is large enough
    const actualOpsSize = values.get("ops_size")!;
    if (actualOpsSize > p.OPS_SIZE) {
      throw new Error(
        `OPS_SIZE too small: actual=${actualOpsSize}, configured=${p.OPS_SIZE}`,
      );
    }

    // Clean up binary
    try {
      Deno.removeSync(bin);
    } catch { /* ignore */ }
  },
});
