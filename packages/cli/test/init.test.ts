import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { exists } from "@std/fs/exists";
import { checkStderr, ct } from "./utils.ts";

describe("cli init", () => {
  it("Initializes workspace", async () => {
    // Tasks always run with deno.json directory as CWD
    // make sure to clean up files
    const root = join(import.meta.dirname!, "..");
    expect(await exists(join(root, "tsconfig.json"))).toEqual(false);
    expect(await exists(join(root, ".ct-types"))).toEqual(false);
    expect(await exists(join(root, ".ct-docs"))).toEqual(false);

    try {
      const { code, stdout, stderr } = await ct("init");
      checkStderr(stderr);
      expect(stdout.length).toBe(0);
      expect(code).toBe(0);

      const types = join(root, ".ct-types");
      expect(await exists(join(root, "tsconfig.json"))).toEqual(true);
      expect(await exists(join(root, ".ct-docs"))).toEqual(true);
      expect(await exists(join(types, "commontools", "index.d.ts"))).toEqual(
        true,
      );
      expect(await exists(join(types, "ct-env", "index.d.ts"))).toEqual(
        true,
      );
      expect(await exists(join(types, "react", "jsx-runtime", "index.d.ts")))
        .toEqual(true);
    } finally {
      await Deno.remove(join(root, "tsconfig.json"), { recursive: true });
      await Deno.remove(join(root, ".ct-types"), { recursive: true });
      await Deno.remove(join(root, ".ct-docs"), { recursive: true });
    }
  });
});
