import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const decoder = new TextDecoder();

Deno.test("cf-profile captures a CPU profile for CLI help", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "cf-profile-test-" });
  try {
    const profilePath = join(tmpDir, "profile.cpuprofile");
    const consolePath = join(tmpDir, "profile.console.log");
    const metaPath = join(tmpDir, "profile.meta.json");
    const scriptPath = fromFileUrl(new URL("cf-profile.ts", import.meta.url));

    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        scriptPath,
        `--profile-output=${profilePath}`,
        "--help",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    assertEquals(result.code, 0, `${stdout}\n${stderr}`);
    assertStringIncludes(stdout, "cf-profile: CPU profile");
    assertStringIncludes(stdout, "Usage:");

    const profileInfo = await Deno.stat(profilePath);
    assert(profileInfo.size > 0);
    const consoleInfo = await Deno.stat(consolePath);
    assert(consoleInfo.size > 0);

    const meta = JSON.parse(await Deno.readTextFile(metaPath));
    assertEquals(meta.command, ["--help"]);
    assertEquals(meta.cliStatus.success, true);
    assertEquals(meta.captureStatus.success, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
