import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cliName } from "../lib/cli-name.ts";
import { checkStderr, ct } from "./utils.ts";

describe("ct compatibility alias", () => {
  it("shows ct in top-level help", async () => {
    const { code, stdout, stderr } = await ct("--help");
    const help = stdout.join("\n");

    expect(code).toBe(0);
    checkStderr(stderr);
    expect(help).toContain("ct check ./pattern.tsx");
    expect(help).toContain(
      "Run 'ct <command> --help' for command-specific help.",
    );
    expect(help).not.toContain("Run 'cf <command> --help'");
  });

  it("shows ct in exec help examples", async () => {
    const { code, stdout, stderr } = await ct("help exec");
    const help = stdout.join("\n");

    expect(code).toBe(0);
    checkStderr(stderr);
    expect(help).toContain(
      "ct exec /tmp/cf/home/pieces/notes/result/add.handler invoke --query milk",
    );
    expect(help).toContain(
      "ct exec /tmp/cf/home/pieces/notes/result/search.tool --query milk",
    );
  });

  it("ignores unsupported CF_CLI_NAME values", () => {
    expect(cliName({ envName: " ct " })).toBe("ct");
    expect(cliName({ envName: "cf.exe" })).toBe("cf");
    expect(cliName({ envName: "$(touch /tmp/pwned)" })).toBe("cf");
    expect(cliName({ envName: "`touch /tmp/pwned`" })).toBe("cf");
  });
});
