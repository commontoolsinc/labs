import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  ALLOWED_SKILL_SCRIPTS_VARIABLE,
  parseAllowedSkillScriptsVariable,
  resolveAllowedSkillScripts,
} from "../../console/allowed-skill-scripts.ts";

const PIN = `commontoolsinc/labs/cf-spend-digest@${"a".repeat(40)}`;

describe("console/allowed-skill-scripts", () => {
  describe("parseAllowedSkillScriptsVariable()", () => {
    it("returns the specs a JSON array holds, in order", () => {
      expect(
        parseAllowedSkillScriptsVariable(
          JSON.stringify([`${PIN}:scripts/budgets.sh`, "cf-tidy:scripts/a.sh"]),
        ),
      ).toEqual([`${PIN}:scripts/budgets.sh`, "cf-tidy:scripts/a.sh"]);
    });

    it("returns nothing for an empty array", () => {
      expect(parseAllowedSkillScriptsVariable("[]")).toEqual([]);
    });

    it("throws naming the variable when the value is not JSON", () => {
      expect(() => parseAllowedSkillScriptsVariable("cf-tidy:scripts/a.sh"))
        .toThrow(ALLOWED_SKILL_SCRIPTS_VARIABLE);
    });

    it("throws when the value is a JSON string rather than an array", () => {
      expect(() => parseAllowedSkillScriptsVariable('"cf-tidy:scripts/a.sh"'))
        .toThrow("array of");
    });

    it("throws when an entry is not a string", () => {
      expect(() => parseAllowedSkillScriptsVariable('["a:scripts/b.sh", 7]'))
        .toThrow("array of");
    });
  });

  describe("resolveAllowedSkillScripts()", () => {
    it("returns a registry entry split at its one colon", () => {
      expect(resolveAllowedSkillScripts(["cf-tidy:scripts/a.sh"], "--flag"))
        .toEqual([{ skill: "cf-tidy", path: "scripts/a.sh" }]);
    });

    it("returns an acquired entry split after its pin", () => {
      expect(
        resolveAllowedSkillScripts([`${PIN}:scripts/budgets.sh`], "--flag"),
      ).toEqual([{ skill: PIN, path: "scripts/budgets.sh" }]);
    });

    it("drops a duplicate entry", () => {
      expect(
        resolveAllowedSkillScripts(
          ["cf-tidy:scripts/a.sh", "cf-tidy:scripts/./a.sh"],
          "--flag",
        ),
      ).toEqual([{ skill: "cf-tidy", path: "scripts/a.sh" }]);
    });

    it("throws naming the source and the entry when a spec has no path", () => {
      expect(() => resolveAllowedSkillScripts(["cf-tidy"], "--flag"))
        .toThrow("`--flag` entry `cf-tidy`");
    });

    it("throws when a spec names a path outside `scripts/`", () => {
      expect(() => resolveAllowedSkillScripts(["cf-tidy:SKILL.md"], "--flag"))
        .toThrow("under scripts/");
    });

    it("throws when an acquired entry names no full commit", () => {
      // The pin is the whole of what an acquired entry keys on, so a spec
      // carrying a branch name splits at the first colon instead and offers
      // `commontoolsinc/labs/cf-spend-digest@main` as a registry name.
      expect(() =>
        resolveAllowedSkillScripts(
          ["commontoolsinc/labs/cf-spend-digest@main:scripts/budgets.sh"],
          "--flag",
        )
      ).toThrow("acquired pin");
    });
  });
});
