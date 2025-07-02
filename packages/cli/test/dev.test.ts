import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { bytesToLines, checkStderr, ct } from "./utils.ts";

describe("cli dev", () => {
  it("Executes a package", async () => {
    const { code, stdout, stderr } = await ct("dev fixtures/pow-5.tsx");
    checkStderr(stderr);
    expect(stdout[stdout.length - 1]).toBe("25");
    expect(code).toBe(0);
  });

  it("Runs a recipe with commontools+3P modules", async () => {
    const { code, stdout, stderr } = await ct("dev fixtures/3p-modules.tsx");
    checkStderr(stderr);
    expect(JSON.parse(stdout.join("\n")).argumentSchema).toBeTruthy();
    expect(code).toBe(0);
  });

  it("Generates output file with correct filename", async () => {
    const temp = await Deno.makeTempFile();
    const { code, stdout, stderr } = await ct(
      `dev fixtures/recipe.tsx --no-run --filename test-file.js --output ${temp}`,
    );
    checkStderr(stderr);
    expect(stdout.length).toBe(0);
    expect(code).toBe(0);
    const rendered = bytesToLines(await Deno.readFile(temp));
    expect(rendered[rendered.length - 1]).toEqual("//# sourceURL=test-file.js");
  });
});
