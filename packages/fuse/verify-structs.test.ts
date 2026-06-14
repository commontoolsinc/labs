// verify-structs.test.ts — Compile and run verify-structs.c to validate
// that the hardcoded struct offsets in platform-linux.ts are correct.
//
// This test only runs on Linux where libfuse3 headers are available.

Deno.test({
  name: "Linux struct offsets match C headers",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const decoder = new TextDecoder();
    const isCi = Deno.env.get("CI") === "true";
    const dir = new URL(".", import.meta.url).pathname;
    const src = `${dir}verify-structs.c`;
    const bin = `${dir}verify-structs`;

    // Get FUSE3 cflags
    const pkgConfig = new Deno.Command("pkg-config", {
      args: ["--cflags", "fuse3"],
      stdout: "piped",
      stderr: "piped",
    });
    let pkgOut: Deno.CommandOutput;
    try {
      pkgOut = await pkgConfig.output();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound && !isCi) {
        console.warn(
          "Skipping Linux FUSE struct verification: pkg-config is missing. " +
            "Install pkg-config, gcc, and libfuse3-dev to run this check.",
        );
        return;
      }
      throw error;
    }
    if (!pkgOut.success) {
      const stderr = decoder.decode(pkgOut.stderr);
      if (!isCi && stderr.includes("Package 'fuse3'")) {
        console.warn(
          "Skipping Linux FUSE struct verification: fuse3 headers were not found by pkg-config. " +
            "Install libfuse3-dev, pkg-config, and gcc to run this check.",
        );
        return;
      }
      throw new Error(
        `pkg-config failed: ${stderr}`,
      );
    }
    const cflags = decoder
      .decode(pkgOut.stdout)
      .trim()
      .split(/\s+/);

    // Compile
    const compile = new Deno.Command("gcc", {
      args: ["-o", bin, src, ...cflags],
      stderr: "piped",
    });
    let compileResult: Deno.CommandOutput;
    try {
      compileResult = await compile.output();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound && !isCi) {
        console.warn(
          "Skipping Linux FUSE struct verification: gcc is missing. " +
            "Install gcc, pkg-config, and libfuse3-dev to run this check.",
        );
        return;
      }
      throw error;
    }
    if (!compileResult.success) {
      throw new Error(
        `gcc failed: ${decoder.decode(compileResult.stderr)}`,
      );
    }

    // Run and check exit status
    const run = new Deno.Command(bin, { stdout: "piped", stderr: "piped" });
    const runResult = await run.output();
    if (!runResult.success) {
      throw new Error(
        `verify-structs exited with code ${runResult.code}: ${
          decoder.decode(runResult.stderr)
        }`,
      );
    }
    const output = decoder.decode(runResult.stdout);

    // Parse key=value pairs
    const values = new Map<string, number>();
    for (const line of output.trim().split("\n")) {
      const [key, val] = line.split("=");
      values.set(key, parseInt(val, 10));
    }

    // Log all values for debugging CI
    console.log("verify-structs output:");
    for (const [k, v] of values) {
      console.log(`  ${k} = ${v}`);
    }

    // Import the platform-linux values to compare
    const linux = await import("./platform-linux.ts");
    const p = linux.default;

    // Collect all mismatches before failing
    const mismatches: string[] = [];
    function check(
      label: string,
      actual: number | undefined,
      expected: number,
    ) {
      if (actual !== expected) {
        mismatches.push(`${label}: actual=${actual}, expected=${expected}`);
      }
    }

    // struct stat
    check("STAT_SIZE", values.get("stat_size"), p.STAT_SIZE);
    check(
      "STAT_ST_SIZE_OFFSET",
      values.get("stat_st_size"),
      p.STAT_ST_SIZE_OFFSET,
    );

    // fuse_entry_param
    check(
      "ENTRY_PARAM_SIZE",
      values.get("entry_param_size"),
      p.ENTRY_PARAM_SIZE,
    );

    // fuse_file_info
    check(
      "FUSE_FILE_INFO_SIZE",
      values.get("file_info_size"),
      p.FUSE_FILE_INFO_SIZE,
    );
    check("file_info_fh", values.get("file_info_fh"), p.FH_OFFSET);

    // fuse_args
    check(
      "FUSE_ARGS_STRUCT_SIZE",
      values.get("fuse_args_size"),
      p.FUSE_ARGS_STRUCT_SIZE,
    );

    // fuse_lowlevel_ops — verify key offsets
    const opsOffsets = p.OPS_OFFSETS;
    for (const [opName, expectedOffset] of Object.entries(opsOffsets)) {
      const key = `ops_${opName}`;
      const actual = values.get(key);
      if (actual !== undefined) {
        check(`OPS_OFFSETS.${opName}`, actual, expectedOffset);
      }
    }

    // Verify ops struct is large enough
    const actualOpsSize = values.get("ops_size")!;
    if (actualOpsSize > p.OPS_SIZE) {
      mismatches.push(
        `OPS_SIZE too small: actual=${actualOpsSize}, configured=${p.OPS_SIZE}`,
      );
    }

    if (mismatches.length > 0) {
      throw new Error(`Struct offset mismatches:\n${mismatches.join("\n")}`);
    }

    // Clean up binary
    try {
      Deno.removeSync(bin);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  },
});
