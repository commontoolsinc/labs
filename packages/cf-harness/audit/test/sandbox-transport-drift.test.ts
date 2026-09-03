/**
 * That AUD-9's list of sandbox-transported side-effect tools is still the set
 * the tools themselves form.
 *
 * The check has to know which side effects an invocation context can exist
 * for, and that knowledge lives in two places: the tools that call
 * `createCfcInvocationContext`, and the set `structural.ts` names. Two
 * encodings of one fact drift, and the second one cannot be derived at
 * runtime — an artifact tree records which contexts a run wrote, never which
 * ones it could have.
 *
 * So this derives the set from the tool sources instead. A tool that gains a
 * sandbox transport, or loses one, fails here rather than turning AUD-9 into a
 * check that demands an artifact nothing can produce, or one that stops asking
 * where it should.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";

import { SANDBOX_TRANSPORTED_SIDE_EFFECT_TOOLS } from "../checks/structural.ts";

const TOOLS_DIR = fromFileUrl(new URL("../../src/tools", import.meta.url));

/** The `toolId` a tool module declares, where it declares one. */
const declaredToolId = (source: string): string | undefined =>
  source.match(/\btoolId:\s*"([^"]+)"/)?.[1];

/**
 * Every side-effect tool whose module asks the engine for an invocation
 * context.
 *
 * Read from the source rather than from the descriptors, because what decides
 * the question is whether the call is there.
 */
const transportingSideEffectTools = async (): Promise<Set<string>> => {
  const found = new Set<string>();
  for await (const entry of Deno.readDir(TOOLS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const source = await Deno.readTextFile(join(TOOLS_DIR, entry.name));
    if (!source.includes("createCfcInvocationContext(")) continue;
    if (!source.includes('effectClass: "side-effect"')) continue;
    const toolId = declaredToolId(source);
    if (toolId !== undefined) {
      found.add(toolId);
    }
  }
  return found;
};

describe("sandbox-transport drift", () => {
  it("names every side-effect tool that records an invocation context", async () => {
    const derived = await transportingSideEffectTools();

    expect([...derived].sort()).toEqual(
      [...SANDBOX_TRANSPORTED_SIDE_EFFECT_TOOLS].sort(),
    );
  });

  it("finds the tools by reading them, so an empty derivation cannot pass", async () => {
    // Without this the test above would agree with an empty list against an
    // empty set, which is the shape a broken reader takes.
    const derived = await transportingSideEffectTools();

    expect(derived.size).toBeGreaterThan(0);
  });
});
