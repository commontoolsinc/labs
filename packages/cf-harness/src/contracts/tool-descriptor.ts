import type { JSONSchema } from "@commonfabric/api";

export type BuiltinToolId =
  | "bash"
  | "browser"
  | "read_file"
  | "view_image"
  | "web_fetch"
  | "read_skill_resource"
  | "run_skill_script"
  | "edit_file"
  | "write_file"
  | "delegate_task"
  | "run_pattern"
  | "assign_slug"
  | "describe_handle"
  | "search_patterns"
  | "record_feedback"
  | "search_skills"
  | "acquire_skill"
  | "query_docs";

export const DEFAULT_PARENT_TOOL_IDS = [
  "bash",
  "read_file",
  "view_image",
  "read_skill_resource",
  "edit_file",
  "write_file",
  "delegate_task",
  "describe_handle",
] as const satisfies readonly BuiltinToolId[];

/**
 * The tools that exist only over a fabric session. They join the tool surface
 * exactly when the run can build one; without it each is absent rather than
 * present-but-failing, even when an explicit allowlist names it.
 */
const FABRIC_SESSION_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["run_pattern", "assign_slug", "acquire_skill"] as const,
);

/**
 * The tools that exist only over the pattern index, gated on the same terms
 * as the fabric-session ones.
 */
const PATTERN_INDEX_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["search_patterns", "record_feedback"] as const,
);

/**
 * The tool gated on a configured documentation corpus. A run given no corpus
 * root has nothing for an explore child to answer out of, so the tool is
 * absent rather than present and answering every question with the same
 * refusal.
 */
const DOCS_CORPUS_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["query_docs"] as const,
);

/** The metadata-only tool gated on configured skills.sh discovery. */
const SKILLS_SH_SEARCH_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["search_skills"] as const,
);

/** The pinned acquisition tool gated separately from discovery. */
const SKILLS_SH_ACQUISITION_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["acquire_skill"] as const,
);

/**
 * The tools that exist only over a skill registry, gated on the same terms.
 * A run given no skills root scans no registry, so `read_skill_resource`
 * would answer `skill_registry_missing` on every call and `run_skill_script`
 * has nothing to run — absent rather than present-but-failing, so a model
 * does not spend turns discovering a tool it was never backed to use.
 */
const SKILL_REGISTRY_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["read_skill_resource", "run_skill_script"] as const,
);

/** What a run can back the gated tools with. */
export interface HarnessToolBackingAvailability {
  fabricSessionAvailable: boolean;
  patternIndexAvailable: boolean;
  skillsShSearchAvailable: boolean;
  skillsShAcquisitionAvailable: boolean;
  skillRegistryAvailable: boolean;
  docsCorpusAvailable: boolean;
}

/** The gated tools this run cannot back, and so does not offer. */
export const withheldToolIds = (
  availability: HarnessToolBackingAvailability,
): ReadonlySet<BuiltinToolId> =>
  new Set([
    ...(availability.fabricSessionAvailable ? [] : FABRIC_SESSION_TOOL_IDS),
    ...(availability.patternIndexAvailable ? [] : PATTERN_INDEX_TOOL_IDS),
    ...(availability.skillsShSearchAvailable ? [] : SKILLS_SH_SEARCH_TOOL_IDS),
    ...(availability.skillsShAcquisitionAvailable
      ? []
      : SKILLS_SH_ACQUISITION_TOOL_IDS),
    ...(availability.skillRegistryAvailable ? [] : SKILL_REGISTRY_TOOL_IDS),
    ...(availability.docsCorpusAvailable ? [] : DOCS_CORPUS_TOOL_IDS),
  ]);

/**
 * The parent tool surface a run offers when nothing narrows it: the default
 * tools plus every gated tool this run's backing supports.
 *
 * This is the one derivation of "which tools does a session have", and every
 * surface that needs the answer asks here. A surface that computed its own
 * list would go stale the next time a gated tool is added — which is how a
 * console session ended up unable to acquire a skill its own registry
 * configuration had already backed.
 */
export const parentToolIdsForBacking = (
  availability: HarnessToolBackingAvailability,
): readonly BuiltinToolId[] => {
  const withheld = withheldToolIds(availability);
  return [
    ...DEFAULT_PARENT_TOOL_IDS,
    ...(availability.fabricSessionAvailable ? FABRIC_SESSION_TOOL_IDS : []),
    ...(availability.patternIndexAvailable ? PATTERN_INDEX_TOOL_IDS : []),
    ...(availability.skillsShSearchAvailable ? SKILLS_SH_SEARCH_TOOL_IDS : []),
    ...(availability.skillsShAcquisitionAvailable
      ? SKILLS_SH_ACQUISITION_TOOL_IDS
      : []),
    ...(availability.docsCorpusAvailable ? DOCS_CORPUS_TOOL_IDS : []),
  ].filter((toolId, index, ids) =>
    !withheld.has(toolId) && ids.indexOf(toolId) === index
  );
};

export type HarnessToolEffectClass = "read" | "write" | "side-effect";

export interface HarnessToolDescriptor {
  toolId: BuiltinToolId;
  title: string;
  description: string;
  effectClass: HarnessToolEffectClass;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  tags?: readonly string[];
}
