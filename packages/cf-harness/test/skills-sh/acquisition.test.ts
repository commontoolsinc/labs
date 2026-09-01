/**
 * Pinned GitHub acquisition and the instructions-only payload boundary. The
 * repository listings are captured metadata fixtures; no test reaches the
 * network or carries a fetched skill payload.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";
import {
  acquireSkillsShPinnedSkill,
  SkillsShAcquisitionError,
} from "../../src/skills-sh/acquisition.ts";
import type { SkillsShPinnedAddress } from "../../src/skills-sh/pin.ts";
import buildgreatTree from "./fixtures/buildgreatproducts-plaid-002ea.tree.json" with {
  type: "json",
};
import membraneTree from "./fixtures/membranedev-application-skills-f484c.tree.json" with {
  type: "json",
};

const MEMBRANE_SHA = "f484c8265e70ec910a57342389cca5c5de7d8167";
const MEMBRANE_PIN: SkillsShPinnedAddress = {
  id: "membranedev/application-skills/plaid",
  owner: "membranedev",
  repo: "application-skills",
  slug: "plaid",
  commitSha: MEMBRANE_SHA,
  resolvedAt: "2026-09-01T02:03:04.000Z",
};
const MEMBRANE_TREE_URL =
  `https://api.github.com/repos/membranedev/application-skills/git/trees/${MEMBRANE_SHA}?recursive=1`;
const MEMBRANE_SKILL_URL =
  `https://raw.githubusercontent.com/membranedev/application-skills/${MEMBRANE_SHA}/skills/plaid/SKILL.md`;

const BUILDGREAT_SHA = "002ea93300572480789719717852dbb7e3107057";
const BUILDGREAT_PIN: SkillsShPinnedAddress = {
  id: "buildgreatproducts/plaid/plaid",
  owner: "buildgreatproducts",
  repo: "plaid",
  slug: "plaid",
  commitSha: BUILDGREAT_SHA,
  resolvedAt: "2026-09-01T02:03:04.000Z",
};
const BUILDGREAT_TREE_URL =
  `https://api.github.com/repos/buildgreatproducts/plaid/git/trees/${BUILDGREAT_SHA}?recursive=1`;

const fixtureFetch = (options: {
  tree?: unknown;
  treeUrl?: string;
  skillUrl?: string;
  skillBody?: BodyInit;
  skillStatus?: number;
} = {}): { fetch: HarnessFetch; urls: string[] } => {
  const tree = options.tree ?? membraneTree;
  const treeUrl = options.treeUrl ?? MEMBRANE_TREE_URL;
  const skillUrl = options.skillUrl ?? MEMBRANE_SKILL_URL;
  const skillBody = options.skillBody ?? "# Plaid\n";
  const urls: string[] = [];
  const fetch: HarnessFetch = (input) => {
    const url = String(input);
    urls.push(url);
    if (url === treeUrl) return Promise.resolve(Response.json(tree));
    if (url === skillUrl) {
      return Promise.resolve(
        new Response(skillBody, { status: options.skillStatus ?? 200 }),
      );
    }
    return Promise.resolve(
      Response.json({ message: "Not Found" }, { status: 404 }),
    );
  };
  return { fetch, urls };
};

/** Returns the typed refusal from `call`, and fails if it resolves. */
const refusalOf = async (
  call: Promise<unknown>,
): Promise<SkillsShAcquisitionError> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsShAcquisitionError);
    return error as SkillsShAcquisitionError;
  }
  throw new Error("expected skill acquisition to refuse, and it resolved");
};

describe("skills.sh pinned acquisition", () => {
  it("loads the single-file membrane skill from its candidate subtree", async () => {
    const { fetch, urls } = fixtureFetch();

    const acquired = await acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch });

    expect(urls).toEqual([MEMBRANE_TREE_URL, MEMBRANE_SKILL_URL]);
    expect(acquired).toEqual({
      pin: MEMBRANE_PIN,
      skillRoot: "skills/plaid",
      sourceUrl: MEMBRANE_SKILL_URL,
      text: "# Plaid\n",
      valueDigest: "sha256:4Br5o34ECSRnIW_OAU598G_sKD7zw23POdRQ6mexrTk",
      loadedPaths: ["SKILL.md"],
    });
    expect(membraneTree._capture.reportedEntryCount).toBe(6_154);
    expect(
      membraneTree.tree.some(({ path }) =>
        path.startsWith("skills/") && !path.startsWith("skills/plaid/")
      ),
    ).toBe(true);
  });

  it("refuses every extra path in the buildgreat candidate root", async () => {
    const { fetch, urls } = fixtureFetch({
      tree: buildgreatTree,
      treeUrl: BUILDGREAT_TREE_URL,
      skillUrl:
        `https://raw.githubusercontent.com/buildgreatproducts/plaid/${BUILDGREAT_SHA}/SKILL.md`,
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch }),
    );

    expect(urls).toEqual([BUILDGREAT_TREE_URL]);
    expect(refusal.code).toBe("instructions_only");
    expect(refusal.offendingCount).toBe(22);
    expect(refusal.offendingPaths).toEqual(
      buildgreatTree.tree
        .map(({ path }) => path)
        .filter((path) => path !== "SKILL.md"),
    );
    expect(refusal.message).toContain("22 offending paths");
    expect(refusal.offendingPaths).toContain("assets/vision-template.json");
    expect(refusal.offendingPaths).toContain("references/plan.md");
    expect(refusal.offendingPaths).toContain("scripts/validate-vision.js");
  });

  it("refuses a truncated recursive tree as an unread listing", async () => {
    const syntheticTruncatedTree = {
      _capture: {
        synthetic: true,
        reason: "GitHub signals recursive-tree truncation with this flag",
      },
      sha: MEMBRANE_SHA,
      truncated: true,
      tree: [{ path: "skills/plaid/SKILL.md", type: "blob" }],
    };
    const { fetch, urls } = fixtureFetch({ tree: syntheticTruncatedTree });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(urls).toEqual([MEMBRANE_TREE_URL]);
    expect(refusal.code).toBe("tree_truncated");
    expect(refusal.message).toContain("truncated");
  });

  it("refuses a tree response without an explicit truncation status", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        tree: [{ path: "skills/plaid/SKILL.md", type: "blob" }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("truncation status");
  });

  it("refuses a tree response without a complete inventory array", async () => {
    const { fetch } = fixtureFetch({
      tree: { sha: MEMBRANE_SHA, truncated: false },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("tree array");
  });

  it("refuses when the exact slug names no candidate root", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{ path: "skills/Plaid/SKILL.md", type: "blob" }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("skill_not_found");
  });

  it("refuses multiple exact candidates even when their parents differ only by case", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{
          path: "skills/PLAID/plaid/SKILL.md",
          type: "blob",
        }, {
          path: "skills/plaid/plaid/SKILL.md",
          type: "blob",
        }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("skill_ambiguous");
    expect(refusal.candidatePaths).toEqual([
      "skills/PLAID/plaid/SKILL.md",
      "skills/plaid/plaid/SKILL.md",
    ]);
  });

  it("matches path segments by exact bytes without case folding", async () => {
    const exactUrl =
      `https://raw.githubusercontent.com/membranedev/application-skills/${MEMBRANE_SHA}/skills/plaid/SKILL.md`;
    const { fetch } = fixtureFetch({
      skillUrl: exactUrl,
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{ path: "skills/plaid/SKILL.md", type: "blob" }, {
          path: "skills/Plaid/SKILL.md",
          type: "blob",
        }],
      },
    });

    const acquired = await acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch });

    expect(acquired.skillRoot).toBe("skills/plaid");
    expect(acquired.sourceUrl).toBe(exactUrl);
  });

  it("sanitizes the hostile candidate root before returning metadata", async () => {
    const hostileRoot =
      "skills/\u001b]8;;attacker\u0007click\u001b]8;;\u0007/plaid";
    const skillPath = `${hostileRoot}/SKILL.md`;
    const skillUrl =
      `https://raw.githubusercontent.com/membranedev/application-skills/${MEMBRANE_SHA}/skills/%1B%5D8%3B%3Battacker%07click%1B%5D8%3B%3B%07/plaid/SKILL.md`;
    const { fetch } = fixtureFetch({
      skillUrl,
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{ path: skillPath, type: "blob" }],
      },
    });

    const acquired = await acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch });

    expect(acquired.skillRoot).toBe("skills/click/plaid");
    expect(acquired.sourceUrl).toBe(skillUrl);
  });

  it("refuses a malformed entry instead of skipping unknown listing data", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{ path: "skills/plaid/SKILL.md", type: "blob" }, {
          path: 42,
          type: "blob",
        }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("malformed tree entry");
  });

  it("refuses a candidate whose root SKILL.md is not a blob", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{ path: "skills/plaid/SKILL.md", type: "tree" }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("SKILL.md is not a blob");
  });

  it("refuses fetched bytes that are not UTF-8", async () => {
    const { fetch } = fixtureFetch({
      skillBody: new Uint8Array([0xff, 0xfe, 0xfd]),
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("invalid_skill_text");
    expect(refusal.message).toContain("UTF-8");
  });

  it("refuses an empty fetched SKILL.md", async () => {
    const { fetch } = fixtureFetch({ skillBody: " \n\t" });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("invalid_skill_text");
    expect(refusal.message).toContain("empty");
  });

  it("refuses a raw-content HTTP error", async () => {
    const { fetch } = fixtureFetch({ skillBody: "missing", skillStatus: 404 });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("http_error");
    expect(refusal.message).toContain("404");
  });

  it("sanitizes a hostile GitHub transport failure", async () => {
    const fetch: HarnessFetch = () =>
      Promise.reject(
        new Error("offline\u001b]8;;attacker\u0007click\u001b]8;;\u0007"),
      );

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("request_failed");
    expect(refusal.message).toBe(
      "GitHub tree could not be reached: offlineclick",
    );
  });

  it("refuses a tree response that is not JSON", async () => {
    const fetch: HarnessFetch = () =>
      Promise.resolve(new Response("{not-json"));

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("not JSON");
  });

  it("refuses a pin without a full lowercase commit SHA before fetching", async () => {
    const { fetch, urls } = fixtureFetch();
    const invalidPin = { ...MEMBRANE_PIN, commitSha: "0123456" };

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(invalidPin, { fetch }),
    );

    expect(refusal.code).toBe("invalid_pin");
    expect(urls).toEqual([]);
  });

  it("refuses pin fields that disagree with the validated discovery id", async () => {
    const { fetch, urls } = fixtureFetch();

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill({ ...MEMBRANE_PIN, owner: "attacker" }, {
        fetch,
      }),
    );

    expect(refusal.code).toBe("invalid_pin");
    expect(urls).toEqual([]);
  });
});
