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
 * Which tagged tasks a section is sent to. A task gets the section when it
 * carries any tag in `anyOf` (any tag at all, when `anyOf` is absent) and none
 * in `noneOf`. A task that was never classified gets it unless
 * `unclassified` is false: such a run carries all of its orientation, but not
 * the blocks that stand in for piece targeting.
 */
export interface SectionAudience {
  readonly anyOf?: readonly HarnessTaskTag[];
  readonly noneOf?: readonly HarnessTaskTag[];
  readonly unclassified?: false;
}

/** The kinds of work each section serves, in one place. */
export const PROMPT_SECTION_AUDIENCE: Readonly<
  Record<PromptSection, SectionAudience>
> = {
  // The opening research pass a fresh task gets before its first turn, and
  // what that pass is.
  "opening-research": { anyOf: ["author"] },
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

/**
 * Whether a run whose task carries `tags` is sent `section`; `undefined` tags
 * mean the task was never classified.
 */
export const sendsSection = (
  section: PromptSection,
  tags: ReadonlySet<HarnessTaskTag> | undefined,
): boolean => {
  const audience = PROMPT_SECTION_AUDIENCE[section];
  if (tags === undefined) return audience.unclassified !== false;
  const has = (tag: HarnessTaskTag) => tags.has(tag);
  return (audience.anyOf === undefined || audience.anyOf.some(has)) &&
    !(audience.noneOf ?? []).some(has);
};

/** The tags a run's recorded classification gave it; none when it has none. */
export const classifiedTags = (
  classification: Pick<HarnessTaskClassification, "tags"> | undefined,
): ReadonlySet<HarnessTaskTag> | undefined =>
  classification === undefined ? undefined : new Set(classification.tags);
