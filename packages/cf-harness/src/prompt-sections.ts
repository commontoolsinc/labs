import type { HarnessRunDepth } from "./contracts/run-depth.ts";
import type {
  HarnessTaskClassification,
  HarnessTaskTag,
} from "./task-classification.ts";

/**
 * The parts of a run's prompt that only some kinds of work call for. Every
 * other part is sent to every run. `PROMPT_SECTION_AUDIENCE` says what each one
 * is and who gets it.
 */
export const PROMPT_SECTIONS = [
  "opening-research",
  "research-guidance",
  "given",
  "findable",
  "code-work",
  "verification",
  "skill-by-id",
  "delegation",
  "browser-host-parent",
  "piece-targeting",
  "held-pieces",
  "may-hold-pieces",
  "revision-verification",
  "weaver-commands",
  "author-tools",
  "research-tools",
  "pieces-tools",
  "resolve-piece-tools",
  "loom-commands-tools",
  "loom-retrieval-tools",
] as const;

export type PromptSection = typeof PROMPT_SECTIONS[number];

/**
 * Which runs a section is sent to. A run gets the section when its task
 * carries any tag in `anyOf` (any tag at all, when `anyOf` is absent) and none
 * in `noneOf`, and its depth is one of `depth` (any, when absent). A task that
 * was never classified passes the tag conditions unless `unclassified` is
 * false: such a run carries all of its orientation, but not the blocks that
 * stand in for piece targeting. The depth conditions hold for every run.
 */
export interface SectionAudience {
  readonly anyOf?: readonly HarnessTaskTag[];
  readonly noneOf?: readonly HarnessTaskTag[];
  readonly unclassified?: false;
  readonly depth?: readonly HarnessRunDepth[];
}

/** What decides which sections a run is sent. */
export interface RunShape {
  /** The task's tags; absent when it was never classified. */
  readonly tags?: ReadonlySet<HarnessTaskTag>;
  readonly depth: HarnessRunDepth;
}

/**
 * The runs each section reaches, in one place. A section with a list of
 * audiences reaches a run any one of them does.
 */
export const PROMPT_SECTION_AUDIENCE: Readonly<
  Record<PromptSection, SectionAudience | readonly SectionAudience[]>
> = {
  // The opening research pass a fresh task gets before its first turn, which
  // a deep run of any kind gets too, and what that pass is.
  "opening-research": [{ anyOf: ["author"] }, { depth: ["deep"] }],
  "research-guidance": { anyOf: ["author"] },
  // Inspect held pieces, grants and retained research before asking.
  given: { anyOf: ["pieces", "find"] },
  // Not given does not mean absent; search the pattern index.
  findable: { anyOf: ["find", "author"] },
  // The work framed as code to read and repair; running verification and
  // repairing what it reports; acquiring a skill named by an exact id.
  "code-work": { anyOf: ["pieces", "author"] },
  verification: { anyOf: ["author"] },
  "skill-by-id": { anyOf: ["pieces", "author"] },
  // Declaring a child's return shape and reading what comes back.
  delegation: { anyOf: ["act", "pieces", "author"] },
  // Web work split into small steps, one browser child each.
  "browser-host-parent": { anyOf: ["act"] },
  // Full piece targeting, and the blocks that stand in for it: how to work on
  // the held pieces, or that the run may hold some.
  "piece-targeting": { anyOf: ["author"] },
  "held-pieces": { anyOf: ["pieces"], unclassified: false },
  "may-hold-pieces": { noneOf: ["pieces"], unclassified: false },
  // Comparing a revision's effect before and after.
  "revision-verification": { anyOf: ["author"] },
  // The Weaver's commands, which read as well as change the application.
  "weaver-commands": { anyOf: ["find", "act"] },
  // Tool guidance: writing and running patterns, building on research,
  // reading and acting on held handles, resolving a named piece (authoring
  // reads that inside piece targeting), the host's commands and retrieval.
  "author-tools": { anyOf: ["author"] },
  "research-tools": { anyOf: ["author", "find", "pieces"] },
  "pieces-tools": { anyOf: ["pieces"] },
  "resolve-piece-tools": {
    anyOf: ["find", "act", "pieces"],
    noneOf: ["author"],
  },
  "loom-commands-tools": { anyOf: ["find", "act"] },
  "loom-retrieval-tools": { anyOf: ["find", "act"] },
};

/** Whether one audience takes in a run of `shape`. */
const reaches = (audience: SectionAudience, shape: RunShape): boolean => {
  const { tags, depth } = shape;
  if (audience.depth !== undefined && !audience.depth.includes(depth)) {
    return false;
  }
  if (tags === undefined) return audience.unclassified !== false;
  const has = (tag: HarnessTaskTag) => tags.has(tag);
  return (audience.anyOf === undefined || audience.anyOf.some(has)) &&
    !(audience.noneOf ?? []).some(has);
};

/** Whether a run of `shape` is sent `section`. */
export const sendsSection = (
  section: PromptSection,
  shape: RunShape,
): boolean => {
  const audience = PROMPT_SECTION_AUDIENCE[section];
  const alternatives = "length" in audience ? audience : [audience];
  return alternatives.some((one) => reaches(one, shape));
};

/** The tags a run's recorded classification gave it; none when it has none. */
export const classifiedTags = (
  classification: Pick<HarnessTaskClassification, "tags"> | undefined,
): ReadonlySet<HarnessTaskTag> | undefined =>
  classification === undefined ? undefined : new Set(classification.tags);
