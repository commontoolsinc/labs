import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolvePath } from "../bundler/normalize-path.ts";

describe("normalize-path", () => {
  it("resolvePath", () => {
    expect(resolvePath("/root.ts", "./foo.ts")).toBe("/foo.ts");
    expect(resolvePath("/a/b/c.ts", "./foo.ts")).toBe("/a/b/foo.ts");
    expect(resolvePath("/a/b/c.ts", ".././../foo.ts")).toBe("/foo.ts");
  });
});
