import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { preloadArgument, spoolWriteArgument } from "./preload-path.ts";

describe("preload-path", () => {
  it("names the preload by an absolute path", () => {
    const argument = preloadArgument();
    expect(argument.startsWith("--preload=/")).toBe(true);
    expect(argument.endsWith("/preload.ts")).toBe(true);
  });

  it("grants the spool where the flags name a write list of their own", () => {
    expect(
      spoolWriteArgument(
        ["--allow-read", "--allow-write=/tmp", "a.test.ts"],
        "/s",
      ),
    ).toBe("--allow-write=/s");
  });

  it("grants the spool where the flags name no write at all", () => {
    expect(spoolWriteArgument(["--allow-read", "a.test.ts"], "/s")).toBe(
      "--allow-write=/s",
    );
  });

  it("grants nothing where the flags already write anywhere", () => {
    // Beside `-A` or `--allow-all` Deno refuses the combination and the
    // run never starts. Beside a bare `--allow-write` or `-W` the list
    // would cut that grant down to itself.
    for (const flag of ["-A", "--allow-all", "-W", "--allow-write"]) {
      expect(spoolWriteArgument([flag, "--allow-read", "a.test.ts"], "/s"))
        .toBeUndefined();
    }
  });

  it("grants nothing where the flags cannot read the tree", () => {
    // A writable spool is what makes the preload wrap `Deno.test`, and
    // the files that replace the class names it takes are found by
    // climbing to `.git`, which the read permission is for.
    expect(spoolWriteArgument(["--allow-env", "a.test.ts"], "/s"))
      .toBeUndefined();
    expect(spoolWriteArgument([], "/s")).toBeUndefined();
  });

  it("reads a cluster of short flags as each of its letters", () => {
    // `-RW` grants read and write together, so it is a blanket write.
    expect(spoolWriteArgument(["-RW", "a.test.ts"], "/s")).toBeUndefined();
    expect(spoolWriteArgument(["-RN", "a.test.ts"], "/s")).toBe(
      "--allow-write=/s",
    );
  });

  it("reads a permission flag only as a whole word", () => {
    expect(
      spoolWriteArgument(["--allow-read", "--allow-write-elsewhere"], "/s"),
    ).toBe("--allow-write=/s");
  });

  it("refuses a spool that is not an absolute path", () => {
    // `--allow-write=` with an empty value ends the run, and a relative
    // path names a different directory in each package the leaves run in.
    expect(() => spoolWriteArgument(["--allow-read"], "")).toThrow();
    expect(() => spoolWriteArgument(["--allow-read"], "spool")).toThrow();
  });
});
