import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { decode } from "@commontools/utils/encoding";
import { join } from "@std/path";
import { exists } from "@std/fs/exists";

function processStream(stream: Uint8Array): string[] {
  return decode(stream).split("\n").filter(Boolean);
}

describe("CLI", () => {
  it("Executes a package", async () => {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      cwd: join(import.meta.dirname!, ".."),
      args: [
        "task",
        "cli",
        "run",
        "test/fixtures/pow-5.tsx",
      ],
    }).output();

    const out = processStream(stdout);
    const err = processStream(stderr);
    expect(err.length).toBe(1); // deno run etc.
    expect(out[out.length - 1]).toBe("25");
    expect(code).toBe(0);
  });

  it("Runs a recipe with commontools", async () => {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      cwd: join(import.meta.dirname!, ".."),
      args: [
        "task",
        "cli",
        "run",
        "test/fixtures/recipe.tsx",
      ],
    }).output();

    const out = processStream(stdout);
    const err = processStream(stderr);
    expect(err.length).toBe(1); // deno run etc.
    expect(JSON.parse(out.join("\n")).argumentSchema).toBeTruthy();
    expect(code).toBe(0);
  });

  it("Generates output file with correct filename", async () => {
    const temp = await Deno.makeTempFile();
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      cwd: join(import.meta.dirname!, ".."),
      args: [
        "task",
        "cli",
        "run",
        "test/fixtures/recipe.tsx",
        "--no-run",
        "--output",
        temp,
        "--filename",
        "test-file.js",
      ],
    }).output();

    const out = processStream(stdout);
    const err = processStream(stderr);
    expect(err.length).toBe(1); // deno run etc.
    expect(out.length).toBe(0);
    expect(code).toBe(0);
    const rendered = processStream(await Deno.readFile(temp));
    expect(rendered[rendered.length - 1]).toEqual("//# sourceURL=test-file.js");
  });

  it("Initializes workspace", async () => {
    // Tasks always run with deno.json directory as CWD
    // make sure to clean up files
    const root = join(import.meta.dirname!, "..");
    expect(await exists(join(root, "tsconfig.json"))).toEqual(false);
    expect(await exists(join(root, "node_modules"))).toEqual(false);

    try {
      const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        cwd: join(import.meta.dirname!, ".."),
        args: [
          "task",
          "cli",
          "init",
        ],
      }).output();

      const out = processStream(stdout);
      const err = processStream(stderr);
      expect(err.length).toBe(1); // deno run etc.
      expect(out.length).toBe(0);
      expect(code).toBe(0);

      const types = join(root, "node_modules", "@types");
      expect(await exists(join(root, "tsconfig.json"))).toEqual(true);
      expect(await exists(join(types, "commontools", "index.d.ts"))).toEqual(
        true,
      );
      expect(await exists(join(types, "commontoolsenv", "index.d.ts"))).toEqual(
        true,
      );
      expect(await exists(join(types, "react", "jsx-runtime", "index.d.ts")))
        .toEqual(true);
    } finally {
      await Deno.remove(join(root, "tsconfig.json"), { recursive: true });
      await Deno.remove(join(root, "node_modules"), { recursive: true });
    }
  });
});
