import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { parseGithubHostCliOptions } from "../src/cli-options.ts";

describe("GitHub host CLI options", () => {
  it("rejects credential-bearing invalid API URLs without retaining them", () => {
    let failure: Error | undefined;
    try {
      parseGithubHostCliOptions([
        "--api-url",
        "https://user:secret@example .com",
        "--config",
        "config.jsonc",
        "--identity",
        "identity.key",
        "--space",
        "space",
      ]);
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toBe("--api-url is not a valid URL");
    expect(failure?.cause).toBeUndefined();
    expect(String(failure).includes("secret")).toBe(false);
  });
});
