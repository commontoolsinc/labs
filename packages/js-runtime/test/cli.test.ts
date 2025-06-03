import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { decode } from "@commontools/utils/encoding";
import { join } from "@std/path";

function processStream(stream: Uint8Array): string[] {
  return decode(stream).split("\n").filter(Boolean);
}

describe("CLI", () => {
  it("Executes a package", async () => {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      cwd: join(import.meta.dirname!, ".."),
      args: [
        "task",
        "run",
        "test/cli-fixtures/index.tsx",
        "test/cli-fixtures/pow.ts",
      ],
    }).output();

    const out = processStream(stdout);
    const err = processStream(stderr);
    expect(err.length).toBe(1); // deno run etc.
    expect(out[out.length - 1]).toBe("25");
    expect(code).toBe(0);
  });
});
