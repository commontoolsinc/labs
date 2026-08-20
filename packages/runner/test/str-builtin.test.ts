import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("str builtin");
const space = signer.did();

const programFor = (body: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { NAME, pattern, str, Writable, Default } from "commonfabric";
export default pattern<{ who?: Writable<string | Default<"world">> }>(({ who }) => {
  ${body}
});
`,
  }],
});

describe("str builtin", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const runProgram = async (body: string, label: string) => {
    const compiled = await runtime.patternManager.compilePattern(
      programFor(body),
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      label,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, compiled, {}, resultCell) as any;
    await tx.commit();
    await result.pull();
    return result;
  };

  it("interpolates a reactive substitution", async () => {
    const result = await runProgram(
      "return { who, greeting: str`Hello, ${who}!` };",
      "interpolates",
    );
    expect(result.key("greeting").get()).toBe("Hello, world!");
  });

  it("recomputes when a substituted cell changes", async () => {
    const result = await runProgram(
      "return { who, greeting: str`Hello, ${who}!` };",
      "recomputes",
    );
    expect(result.key("greeting").get()).toBe("Hello, world!");

    const writeTx = runtime.edit();
    result.withTx(writeTx).key("who").set("fabric");
    await writeTx.commit();
    await runtime.idle();
    await result.pull();
    expect(result.key("greeting").get()).toBe("Hello, fabric!");
  });

  it("interpolates several substitutions in order", async () => {
    const result = await runProgram(
      "return { who, greeting: str`a${who}b${who}c` };",
      "several",
    );
    expect(result.key("greeting").get()).toBe("aworldbworldc");
  });

  it("returns the template unchanged when it has no substitutions", async () => {
    const result = await runProgram(
      "return { who, greeting: str`no substitutions` };",
      "no-subs",
    );
    expect(result.key("greeting").get()).toBe("no substitutions");
  });

  it("renders a substitution exactly as a native template literal does", async () => {
    const result = await runProgram(
      "return { who, greeting: str`v=${undefined} ${null} ${{ a: 1 }}` };",
      "native-parity",
    );
    // Matches `v=${undefined} ${null} ${{ a: 1 }}` evaluated natively: authors
    // reach for `str` in place of a template literal, so the rendering rules
    // must not shift underneath them.
    expect(result.key("greeting").get()).toBe(
      `v=${undefined} ${null} ${{ a: 1 }}`,
    );
  });

  it("resolves without falling back to unverified source", async () => {
    const fallbackCount = () =>
      ((getLoggerCountsBreakdown() as Record<
        string,
        Record<string, { total?: number }>
      >)["runner"]?.["unverified-source-fallback"]?.total) ?? 0;

    const before = fallbackCount();
    await runProgram(
      "return { who, greeting: str`Hello, ${who}!` };",
      "verified",
    );
    // `str` resolves through the builtin registry, so nothing in this program
    // re-evaluates stringified source in a bare SES compartment.
    expect(fallbackCount()).toBe(before);
  });
});
