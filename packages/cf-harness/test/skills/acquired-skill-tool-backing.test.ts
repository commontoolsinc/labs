/**
 * Which backing makes `run_skill_script` a tool a run offers.
 *
 * Its two backings are independent, and the gate that reads them is the one
 * that decides whether a child holding a mounted acquired skill can execute
 * anything at all. A child's tool surface passes through
 * `withheldToolIds` a second time inside its own prompt loop, so an allowance
 * added upstream survives only if the backing agrees.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type HarnessToolBackingAvailability,
  withheldToolIds,
} from "../../src/contracts/tool-descriptor.ts";

const backing = (
  overrides: Partial<HarnessToolBackingAvailability> = {},
): HarnessToolBackingAvailability => ({
  fabricSessionAvailable: true,
  patternIndexAvailable: true,
  skillsShSearchAvailable: true,
  skillsShAcquisitionAvailable: true,
  skillRegistryAvailable: false,
  docsCorpusAvailable: true,
  ...overrides,
});

describe("withheldToolIds() over the skill tools", () => {
  it("offers run_skill_script to a run holding an acquired skill and no registry", () => {
    // The bytes came from a pinned commit and this run mounts them. A child
    // given the skill but not the tool holds a mounted skill it cannot run.
    const withheld = withheldToolIds(
      backing({ acquiredSkillsAvailable: true }),
    );

    expect(withheld.has("run_skill_script")).toBe(false);
  });

  it("still withholds read_skill_resource, which only a registry backs", () => {
    // An acquired skill carries no resource index, so the read tool would
    // answer `skill_registry_missing` on every call.
    const withheld = withheldToolIds(
      backing({ acquiredSkillsAvailable: true }),
    );

    expect(withheld.has("read_skill_resource")).toBe(true);
  });

  it("withholds run_skill_script when neither backing is there", () => {
    expect(withheldToolIds(backing()).has("run_skill_script")).toBe(true);
    expect(
      withheldToolIds(backing({ acquiredSkillsAvailable: false })).has(
        "run_skill_script",
      ),
    ).toBe(true);
  });

  it("offers both to a run with a skills root and no acquisition", () => {
    const withheld = withheldToolIds(backing({ skillRegistryAvailable: true }));

    expect(withheld.has("run_skill_script")).toBe(false);
    expect(withheld.has("read_skill_resource")).toBe(false);
  });
});
