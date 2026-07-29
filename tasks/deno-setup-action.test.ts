import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "deno-setup",
  "action.yml",
);
const CACHE_MISS_STEP = "    - name: 🧹 Clear Deno toolchain after cache miss";

function cacheMissStep(action: string): string {
  const start = action.indexOf(CACHE_MISS_STEP);
  assert(start >= 0, "cache-miss cleanup step not found");
  const next = action.indexOf("\n    - name:", start + CACHE_MISS_STEP.length);
  return action.slice(start, next < 0 ? action.length : next);
}

function shellScript(step: string): string {
  const marker = "      run: ";
  const start = step.indexOf(marker);
  assert(start >= 0, "cache-miss cleanup shell script not found");
  return step.slice(start + marker.length).split("\n", 1)[0];
}

Deno.test(
  "Deno setup removes a partial toolchain after cache extraction fails",
  async () => {
    const root = await Deno.makeTempDir({
      prefix: "deno-toolchain-cache-test-",
    });
    try {
      const toolchainDir = join(root, "toolcache", "deno", "2.8.1");
      const binDir = join(toolchainDir, "x64");
      const bin = join(binDir, "deno");
      await Deno.mkdir(binDir, { recursive: true });
      await Deno.writeTextFile(
        bin,
        "#!/usr/bin/env bash\n" +
          'echo "Bus error (core dumped)" >&2\n' +
          "exit 135\n",
      );
      await Deno.chmod(bin, 0o755);

      const action = await Deno.readTextFile(ACTION_PATH);
      assertStringIncludes(
        action,
        "key: deno-bin-${{ runner.os }}-${{ runner.arch }}-" +
          "${{ steps.resolve.outputs.version }}",
      );
      const step = cacheMissStep(action);
      assertStringIncludes(
        step,
        "if: steps.deno-toolchain-cache.outputs.cache-hit != 'true'",
      );
      const output = await new Deno.Command("bash", {
        args: [
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          shellScript(step),
        ],
        env: {
          TOOLCHAIN_DIR: toolchainDir,
        },
      }).output();
      const stderr = new TextDecoder().decode(output.stderr);

      assertEquals(
        output.code,
        0,
        `cached Deno recovery exited ${output.code}:\n${stderr}`,
      );
      await assertRejects(
        () => Deno.stat(toolchainDir),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
