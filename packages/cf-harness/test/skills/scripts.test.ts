import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { splitSkillsShPin } from "../../src/skills-sh/pin.ts";

import {
  allowedSkillScriptKey,
  allowedSkillScriptsContextMessage,
  isAllowedSkillScriptSkill,
  isSkillScriptAllowlisted,
  normalizeAllowedSkillScript,
  parseAcquiredSkillPin,
  parseAllowedSkillScriptSpec,
  uniqueAllowedSkillScripts,
} from "../../src/skills/scripts.ts";

const SHA = "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c";
const PIN = `zubair-trabzada/ai-finance-claude/finance-budget@${SHA}`;

describe("scripts.ts", () => {
  //
  // What an allowlist entry may name
  //
  // A registry skill is named; an acquired skill has no registry name and is
  // named by the pin its bytes were read at, which identifies the exact bytes
  // rather than a directory. Both go through one key, so the operator decides
  // one kind of thing.
  //

  describe("normalizeAllowedSkillScript()", () => {
    it("accepts a registry skill's name", () => {
      expect(
        normalizeAllowedSkillScript({
          skill: "agent-browser",
          path: "scripts/run.ts",
        }),
      ).toEqual({ skill: "agent-browser", path: "scripts/run.ts" });
    });

    it("accepts an acquired skill's pin", () => {
      expect(
        normalizeAllowedSkillScript({ skill: PIN, path: "scripts/report.sh" }),
      ).toEqual({ skill: PIN, path: "scripts/report.sh" });
    });

    it("throws for a pin whose commit is not a full lowercase SHA", () => {
      expect(() =>
        normalizeAllowedSkillScript({
          skill: "owner/repo/slug@DD93980",
          path: "scripts/a.sh",
        })
      ).toThrow("acquired pin");
    });

    it("throws for a pin whose discovery id has no skill segment", () => {
      expect(() =>
        normalizeAllowedSkillScript({
          skill: `owner/repo@${SHA}`,
          path: "scripts/a.sh",
        })
      ).toThrow("acquired pin");
    });

    it("throws for a name that is neither a registry name nor a pin", () => {
      expect(() =>
        normalizeAllowedSkillScript({ skill: "Not A Name", path: "scripts/a" })
      ).toThrow("acquired pin");
    });

    it("throws for a path outside the skill's scripts directory", () => {
      expect(() =>
        normalizeAllowedSkillScript({ skill: PIN, path: "SKILL.md" })
      )
        .toThrow("under scripts/");
    });
  });

  describe("parseAllowedSkillScriptSpec()", () => {
    it("splits an acquired pin's spec at the colon the path opens with", () => {
      // Neither a discovery id nor a commit SHA carries a colon, so widening
      // the skill field did not move where the separator is.
      expect(parseAllowedSkillScriptSpec(`${PIN}:scripts/report.sh`)).toEqual({
        skill: PIN,
        path: "scripts/report.sh",
      });
    });

    it("splits a registry skill's spec the same way", () => {
      expect(parseAllowedSkillScriptSpec("agent-browser:scripts/run.ts"))
        .toEqual({ skill: "agent-browser", path: "scripts/run.ts" });
    });

    it("splits after the pin for a discovery slug that holds a colon", () => {
      // A slug admits a colon, so the FIRST colon can fall inside the skill
      // field. What bounds the pin is the commit SHA, whose alphabet holds
      // none; splitting at the first would leave such a script unnameable.
      const colonPin = `owner/repo/ns:budget@${SHA}`;
      expect(parseAllowedSkillScriptSpec(`${colonPin}:scripts/report.sh`))
        .toEqual({ skill: colonPin, path: "scripts/report.sh" });
    });

    it("splits at the first colon when what precedes it is no pin", () => {
      // `a:b@<not a sha>` is a registry-shaped spec whose path happens to
      // carry an `@`, and it must not be read as an acquired one.
      expect(parseAllowedSkillScriptSpec("agent-browser:scripts/run@v2.ts"))
        .toEqual({ skill: "agent-browser", path: "scripts/run@v2.ts" });
    });
  });

  describe("isSkillScriptAllowlisted()", () => {
    it("returns true for an acquired script the operator named exactly", () => {
      expect(
        isSkillScriptAllowlisted([{ skill: PIN, path: "scripts/report.sh" }], {
          skill: PIN,
          path: "scripts/report.sh",
        }),
      ).toBe(true);
    });

    it("returns false for the same script acquired at another commit", () => {
      // The pin is the key, so a second acquisition of the same skill at a
      // different commit is a different script to decide about.
      const other = `zubair-trabzada/ai-finance-claude/finance-budget@${
        "0".repeat(40)
      }`;
      expect(
        isSkillScriptAllowlisted([{ skill: PIN, path: "scripts/report.sh" }], {
          skill: other,
          path: "scripts/report.sh",
        }),
      ).toBe(false);
    });

    it("returns false for an empty allowlist", () => {
      expect(isSkillScriptAllowlisted([], { skill: PIN, path: "scripts/a.sh" }))
        .toBe(false);
    });
  });

  describe("allowedSkillScriptKey()", () => {
    it("returns the pin and the path joined, so one entry names one script", () => {
      expect(allowedSkillScriptKey({ skill: PIN, path: "scripts/report.sh" }))
        .toBe(`${PIN}:scripts/report.sh`);
    });
  });

  describe("uniqueAllowedSkillScripts()", () => {
    it("keeps one entry for a script named twice across the two forms", () => {
      expect(
        uniqueAllowedSkillScripts([
          { skill: PIN, path: "scripts/report.sh" },
          { skill: PIN, path: "./scripts/report.sh" },
          { skill: "agent-browser", path: "scripts/run.ts" },
        ]),
      ).toEqual([
        { skill: PIN, path: "scripts/report.sh" },
        { skill: "agent-browser", path: "scripts/run.ts" },
      ]);
    });
  });

  describe("allowedSkillScriptsContextMessage()", () => {
    it("names the operator's entries and no others", () => {
      // Exclusivity rather than inclusion: a `toContain` per entry stays green
      // when a later change leaks a pair the operator never wrote, and a
      // disclosure that names a script nobody allowed is the failure worth
      // catching. So the whole bullet list is the assertion.
      const message = allowedSkillScriptsContextMessage([
        { skill: PIN, path: "scripts/report.sh" },
        { skill: "agent-browser", path: "scripts/run.ts" },
      ]);

      expect(
        (message ?? "").split("\n").filter((line) => line.startsWith("- ")),
      ).toEqual([
        `- ${PIN} -> scripts/report.sh`,
        "- agent-browser -> scripts/run.ts",
      ]);
    });

    it("says to acquire by the whole pin", () => {
      // The pin is the point: acquiring the same skill by name alone resolves
      // to the default-branch head, which is the allowed bytes only by luck.
      expect(
        allowedSkillScriptsContextMessage([
          { skill: PIN, path: "scripts/report.sh" },
        ]),
      ).toContain("`acquire_skill` id");
    });

    it("names a registry entry alone, which the run can learn nowhere else", () => {
      const message = allowedSkillScriptsContextMessage([
        { skill: "agent-browser", path: "scripts/run.ts" },
      ]);

      expect(
        (message ?? "").split("\n").filter((line) => line.startsWith("- ")),
      ).toEqual(["- agent-browser -> scripts/run.ts"]);
    });

    it("says nothing about acquiring for a registry-only allowlist", () => {
      // There is no pin to acquire by, so the instruction would name a
      // spelling none of the entries has.
      expect(
        allowedSkillScriptsContextMessage([
          { skill: "agent-browser", path: "scripts/run.ts" },
        ]),
      ).not.toContain("`acquire_skill` id");
    });

    it("returns nothing for an empty or absent allowlist", () => {
      expect(allowedSkillScriptsContextMessage([])).toBeUndefined();
      expect(allowedSkillScriptsContextMessage(undefined)).toBeUndefined();
    });
  });

  describe("parseAcquiredSkillPin()", () => {
    it("splits a pin exactly as `splitSkillsShPin` does", () => {
      // Two splitters that agree only by inspection would reopen the failure
      // the one spelling exists to prevent: an allowlist entry and an
      // acquisition naming different bytes while both look valid.
      for (
        const candidate of [
          PIN,
          `${PIN}@${SHA}`,
          `owner/repo/slug@${SHA}`,
          `owner/repo/slug@${SHA.toUpperCase()}`,
          `owner/repo/slug@${SHA.slice(0, 7)}`,
          "owner/repo/slug@main",
          "owner/repo/slug",
          "agent-browser",
          `@${SHA}`,
          "",
        ]
      ) {
        const split = splitSkillsShPin(candidate);
        const parsed = parseAcquiredSkillPin(candidate);
        if (parsed !== undefined) {
          expect(parsed).toEqual(split);
        } else {
          // Where they part it is the head, which only this one validates.
          expect(
            split === undefined || !isAllowedSkillScriptSkill(candidate),
          ).toBe(true);
        }
      }
    });
  });
});
