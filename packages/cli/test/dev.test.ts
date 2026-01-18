import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { bytesToLines, checkStderr, ct } from "./utils.ts";

describe("cli dev", () => {
  it("Executes a package", async () => {
    const { code, stdout, stderr } = await ct(
      "dev fixtures/pow-5.tsx --pattern-json",
    );
    checkStderr(stderr);
    expect(stdout[stdout.length - 1]).toBe("25");
    expect(code).toBe(0);
  });

  it("Runs a recipe with commontools+3P modules", async () => {
    const { code, stdout, stderr } = await ct(
      "dev fixtures/3p-modules.tsx --pattern-json",
    );
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

  it("Uses default export when no --main-export specified", async () => {
    const { code, stdout, stderr } = await ct(
      "dev fixtures/named-export.tsx --pattern-json",
    );
    checkStderr(stderr);
    const output = JSON.parse(stdout.join("\n"));
    expect(output.result.message).toBe("from default export");
    expect(code).toBe(0);
  });

  it("Uses specified named export with --main-export", async () => {
    const { code, stdout, stderr } = await ct(
      "dev fixtures/named-export.tsx --main-export myNamedRecipe --pattern-json",
    );
    checkStderr(stderr);
    const output = JSON.parse(stdout.join("\n"));
    // Named export uses cell reference, so check the argument schema
    expect(output.argumentSchema.default.message).toBe("from named export");
    // Also verify mainExport was set correctly in program
    expect(output.program.mainExport).toBe("myNamedRecipe");
    expect(code).toBe(0);
  });

  it("Produces no output on success by default", async () => {
    const { code, stdout, stderr } = await ct("dev fixtures/pow-5.tsx");
    checkStderr(stderr);
    expect(stdout.length).toBe(0);
    expect(code).toBe(0);
  });
});
