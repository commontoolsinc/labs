import type { HarnessTaskTag } from "./task-classification.ts";

const OPENING_RESEARCH_GUIDANCE =
  "For a fresh task eligible for opening research, attached patternRefs or explicit pattern:<space>/<slug>, cf:pattern:<id>, or skill:<id> markers in the current request skip that pass. A skill marker names a registered skill or an owner/repository/skill address. Prose such as 'use the named skill X' remains open unless X uses a marker. Use the selected implementation through its ordinary tools; call research for a specific unresolved question if needed.";

const GOAL_GUIDANCE =
  "Orient to the user's goal: distinguish what is given, what is findable within the granted scope, and what the available capabilities cannot do. Work toward the closest achievable outcome and state any limitation before asking for details that cannot remove it.";

const GIVEN_GUIDANCE =
  "Given: check relevant attached or focused pieces, conversation targets, grants, and retained research. Reuse established descriptions; inspect unresolved relevant handles with describe_handle before asking the user to connect or attach that source. A grant's name is a lead, not its contents: a calendar-named grant may describe mail, and a document source may already be available. Descriptions establish shape and capabilities, not the requested values.";

const findableGuidance = (patternIndex: boolean): string =>
  [
    "Findable: not given does not mean absent.",
    ...(patternIndex
      ? [
        "Search the pattern index for an applicable space-search pattern and use it over held references when the tools and release rules permit.",
      ]
      : []),
    "Private research inspects candidates and tells the parent what to run; it cannot execute them.",
    ...(patternIndex
      ? ["The parent can run an indexed pattern with run_pattern."]
      : []),
    "Keep the existing piece-targeting bounds: resolve_piece first for a slug, zero registry reads for an unnamed target, and at most one lookup for a display name. Explicit requests to list or analyze the space are not missing-target lookups.",
  ].join(" ");

const ACTION_PATH_GUIDANCE =
  "Check the action path too: read-only data does not grant a write or send capability. Before asking for a recipient or other execution detail, establish that an available tool, skill, or pattern can perform the action with the held authority. If sending is unavailable, say so immediately and offer a draft instead of implying an address will enable sending. Never promise a write to an ungranted store.";

const EVIDENCE_GUIDANCE =
  "Found requires released evidence; absent is limited to the scope actually checked. An unavailable, refused, or pending read stays unknown. Inspect run_pattern outputConcerns and the declared error branch before treating an empty result as data. Do not repeat probes or delegation to rediscover the same blocker. Offer the useful part you can achieve without silently substituting a different source or claiming the original goal is complete.";

const RELEASE_REFUSAL_GUIDANCE =
  "A release refusal is not a request for a new permission. Follow the existing not-checked verification rule: describe only the successfully applied change, say the result could not be inspected, and point to the piece. Never ask the user to release aggregates or change a sink ceiling through a control that does not exist. Actual execution or write failures still need repair or an honest failure report.";

/** How the parent hands work to a child and reads what comes back. */
export const DELEGATION_GUIDANCE = [
  "When you delegate, declare the return shape up front: say in the delegation what the child must return, and give a returnSchema whenever the caller interface allows one. A returned reference means something only together with the contract it satisfied.",
  "Say what the child should do when it cannot succeed, and expect a failure answer rather than a substitute. A child that failed has produced nothing: never present an earlier step's reference, a partial result, or your own expectation as its output.",
  "Check a returned reference by shape before you use it. describe_handle reports the schema and path behind a handle token and never its value, so you can confirm a reference is the kind of thing the next step expects without reading the data.",
].join("\n");

/**
 * Shared guidance for finding a feasible path before asking or giving up.
 * A run with no pattern index is not told to search one or to run what it
 * finds there. Given task tags, it carries the paragraphs those kinds of work
 * need and the ones every task needs; without them, all of it.
 */
export const orientationGuidance = (
  { patternIndex, tags }: {
    patternIndex: boolean;
    tags?: ReadonlySet<HarnessTaskTag>;
  },
): string => {
  const tagged = (...wanted: HarnessTaskTag[]) =>
    tags === undefined || wanted.some((tag) => tags.has(tag));
  return [
    ...(tagged("author") ? [OPENING_RESEARCH_GUIDANCE] : []),
    GOAL_GUIDANCE,
    ...(tagged("pieces", "find") ? [GIVEN_GUIDANCE] : []),
    ...(tagged("find", "author") ? [findableGuidance(patternIndex)] : []),
    ACTION_PATH_GUIDANCE,
    EVIDENCE_GUIDANCE,
    RELEASE_REFUSAL_GUIDANCE,
  ].join("\n\n");
};

/** Whether a task with these tags is told how to delegate. */
export const delegationGuided = (
  tags: ReadonlySet<HarnessTaskTag> | undefined,
): boolean =>
  tags === undefined || tags.has("act") || tags.has("pieces") ||
  tags.has("author");
