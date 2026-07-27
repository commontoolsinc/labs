/**
 * Ahead-of-time compatibility verdict for `cf piece setsrc`.
 *
 * Why: replacing a piece's pattern source can be refused for several distinct
 * reasons, and until now the only way to learn which one applied was to attempt
 * the update and read a low-level rejection out of the commit path. That cost a
 * production incident on the hosted Estuary deployment: home roots and profile
 * pieces were pinned to patterns that could not migrate their existing
 * documents, and the failure only surfaced as a CFC commit rejection deep inside
 * setup.
 *
 * This module assembles the verdict from the SAME rule implementations the real
 * update runs — `patternSchemaCompatibilityIssues` (the pattern-contract
 * subset proof), `cfcSchemaMergeIssue` (the CFC document merge), and the caller's
 * run of `assertSuppliedLinkSchemasCompatible` — so the preflight cannot drift
 * away from what the update actually enforces. Nothing here reads or writes
 * storage; the caller gathers the stored envelopes read-only and hands them in.
 */

import type { JSONSchema, Pattern } from "@commonfabric/runner";
import { cfcSchemaMergeIssue, isStreamSlot } from "@commonfabric/runner/cfc";
import { patternSchemaCompatibilityIssues } from "./schema-compatibility.ts";

/** Which side of the pattern's contract a finding concerns. */
export type PatternUpdateRole = "argument" | "result";

export type PatternUpdateBlockerClass =
  /** The candidate pattern's declared contract is not an evolution of the
   * running pattern's (field removed, type mutated, bound narrowed, a newly
   * required field with no default). Enforced by
   * `assertPatternSchemasBackwardCompatible`. */
  | "pattern-contract"
  /** The stored document cannot be migrated onto the candidate's schema
   * because a now-required field carries no default. Enforced by the CFC
   * schema merge at commit time. */
  | "cfc-schema-migration"
  /** Any other CFC envelope merge rejection (an incompatible type change, an
   * IFC claim that cannot be weakened). Also enforced at commit time. */
  | "cfc-schema-merge"
  /** A durable link already supplied into an argument slot would no longer
   * satisfy the candidate's schema for that slot. */
  | "retained-link";

export interface PatternUpdateBlocker {
  class: PatternUpdateBlockerClass;
  /** `argument` = the pattern's INPUT contract; `result` = its OUTPUT. */
  role?: PatternUpdateRole;
  /** Dotted schema path the rule reported, when it named one. */
  path?: string;
  /** The single field the rule named, when it named one. */
  field?: string;
  /**
   * The named field is a handler stream on the candidate's contract — a
   * runtime-materialized capability marker, not stored document data. The CFC
   * document merge exempts such a slot from its additive-required rule
   * (labs#4977); the pattern-contract proof does not. A blocker carrying this
   * flag is therefore refused by the contract layer alone, and the two layers
   * disagree about it.
   */
  streamSlot?: true;
  /** The rule's own reason, verbatim. */
  reason: string;
  /** A full sentence suitable for printing on its own. */
  message: string;
}

export interface PatternUpdateAdvisory {
  /** Not a blocker: the update succeeds, but setup has migration work to do. */
  class: "setup-migration";
  role: PatternUpdateRole;
  field: string;
  message: string;
}

export type PatternUpdateCheckStatus = "pass" | "fail" | "not-applicable";

export interface PatternUpdateCheckStep {
  name: string;
  status: PatternUpdateCheckStatus;
  /** Why a step was skipped, or what it proved. */
  note?: string;
}

export interface PatternUpdateCheckReport {
  piece: string;
  /** True when every applicable rule accepted the update. */
  compatible: boolean;
  steps: PatternUpdateCheckStep[];
  blockers: PatternUpdateBlocker[];
  advisories: PatternUpdateAdvisory[];
}

/**
 * A pattern update was refused because the candidate is not compatible with the
 * piece as it stands.
 *
 * Why a dedicated class: the underlying rejections arrive in several shapes —
 * a schema-subset assertion, a CFC commit rejection re-wrapped as a plain
 * `Error` at the runner's setup boundary, a retained-link proof failure — and
 * the useful part (WHICH field, and under WHICH rule) was previously buried in
 * whichever low-level message happened to surface first. Carrying the same
 * {@link PatternUpdateBlocker} list the `--check` preflight reports means the
 * enforced path and the preflight can never disagree about the reason.
 */
export class PatternUpdateIncompatibleError extends Error {
  readonly piece: string;
  readonly blockers: readonly PatternUpdateBlocker[];

  constructor(
    piece: string,
    blockers: readonly PatternUpdateBlocker[],
    options?: { cause?: unknown },
  ) {
    // The actionable reasons lead. The originating message is kept as a
    // subordinate trailing line rather than dropped: a CLI renders only the
    // blockers (see `reportIncompatibleSetSource`), but a library consumer
    // reading `.message` or a stack trace still gets the low-level detail.
    const underlying = options?.cause instanceof Error
      ? options.cause.message
      : undefined;
    super(
      `Pattern source cannot be applied to piece ${piece}:\n${
        blockers.map((blocker) => `- ${blocker.message}`).join("\n")
      }${underlying === undefined ? "" : `\nCaused by: ${underlying}`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "PatternUpdateIncompatibleError";
    this.piece = piece;
    this.blockers = blockers;
  }
}

/** Everything the verdict needs, gathered read-only by the caller. */
export interface PatternUpdateCheckInput {
  piece: string;
  previous: Pattern;
  candidate: Pattern;
  /**
   * The CFC schema envelopes currently at rest for the piece's argument and
   * result documents. `undefined` for a role means that document carries no
   * stored CFC envelope, in which case the CFC merge never runs for it at
   * commit time and the class genuinely cannot fail.
   */
  storedCfcEnvelopes: Partial<Record<PatternUpdateRole, JSONSchema>>;
  /**
   * Outcome of the caller's run of the real retained-link validator. `ran:
   * false` means the caller could not evaluate it (no argument cell), which is
   * reported as not-applicable rather than silently passing.
   */
  retainedLinks: { ran: boolean; issue?: string; note?: string };
}

const ROLE_LABEL: Record<PatternUpdateRole, string> = {
  argument: "input (argument)",
  result: "output (result)",
};

/**
 * Split `"argument.favorites: newly required argument field has no default"`
 * into its path, its leaf field, and the bare reason. The path's first segment
 * is the role, which is how the report tells an INPUT finding from an OUTPUT
 * one.
 */
export function parseContractIssue(issue: string): PatternUpdateBlocker {
  const separator = issue.indexOf(": ");
  const path = separator === -1 ? undefined : issue.slice(0, separator);
  const reason = separator === -1 ? issue : issue.slice(separator + 2);
  const segments = path?.split(".") ?? [];
  const role = segments[0] === "argument"
    ? "argument"
    : segments[0] === "result"
    ? "result"
    : undefined;
  const field = segments.length > 1 ? segments[segments.length - 1] : undefined;
  return {
    class: "pattern-contract",
    ...(role ? { role } : {}),
    ...(path ? { path } : {}),
    ...(field ? { field } : {}),
    reason,
    message: field
      ? `${path} — ${reason}. This is the pattern's ${
        ROLE_LABEL[role ?? "argument"]
      } contract.`
      : `${path ?? "pattern"} — ${reason}.`,
  };
}

/**
 * Mark a contract blocker whose field is a handler stream, and say so in the
 * message.
 *
 * Why it matters: the two layers that gate a source swap disagree about this
 * case. The CFC document merge exempts a stream slot from its
 * additive-required rule — a stream marker is re-materialized by setup on
 * every run, so an old document that lacks one has no value to preserve and no
 * meaningful default to declare. The pattern-contract subset proof has no such
 * exemption, so it still refuses the update. Reporting the refusal truthfully
 * (rather than suppressing it to match the CFC layer) is what keeps the
 * preflight's verdict equal to what `setsrc` will actually do; naming the
 * disagreement is what makes the refusal actionable.
 */
function annotateStreamSlot(
  blocker: PatternUpdateBlocker,
  candidate: Pattern,
): PatternUpdateBlocker {
  if (blocker.field === undefined || blocker.role === undefined) return blocker;
  const properties = schemaProperties(
    blocker.role === "argument"
      ? candidate.argumentSchema
      : candidate.resultSchema,
  );
  if (!isStreamSlot(properties[blocker.field])) return blocker;
  return {
    ...blocker,
    streamSlot: true,
    message:
      `${blocker.message} \`${blocker.field}\` is a handler stream: it ` +
      `holds no stored document data, and the CFC document layer already ` +
      `exempts such a slot — only the pattern-contract proof refuses it. ` +
      `Declaring the field optional on the pattern's contract clears this.`,
  };
}

/** `"required field favorites needs a default …"` -> `favorites`. */
function cfcNamedField(message: string): string | undefined {
  return /^required field (\S+) needs a default/.exec(message)?.[1];
}

/**
 * Named slots the candidate declares as streams that the running pattern did
 * not. These are handler streams; setup materializes their `{ "$stream": true }`
 * marker over the existing document, so they are migration WORK rather than an
 * incompatibility — the CFC merge exempts a stream slot from the
 * additive-required default rule precisely because it holds no preservable
 * document data.
 */
function streamSlotAdvisories(
  previous: Pattern,
  candidate: Pattern,
): PatternUpdateAdvisory[] {
  const advisories: PatternUpdateAdvisory[] = [];
  for (const role of ["argument", "result"] as const) {
    const before = schemaProperties(
      role === "argument" ? previous.argumentSchema : previous.resultSchema,
    );
    const after = schemaProperties(
      role === "argument" ? candidate.argumentSchema : candidate.resultSchema,
    );
    for (const [field, schema] of Object.entries(after)) {
      if (!isStreamSlot(schema)) continue;
      if (isStreamSlot(before[field])) continue;
      advisories.push({
        class: "setup-migration",
        role,
        field,
        message:
          `\`${field}\` is a new handler stream on the ${ROLE_LABEL[role]} ` +
          `contract. Setup will materialize its stream marker on the existing ` +
          `document; no stored value is lost.`,
      });
    }
  }
  return advisories;
}

function schemaProperties(
  schema: JSONSchema | undefined,
): Record<string, JSONSchema> {
  if (typeof schema !== "object" || schema === null) return {};
  return schema.properties ?? {};
}

/**
 * Decide whether `candidate` can replace `previous` on this piece, and say why
 * not when it cannot. Pure: every rule is driven over values the caller already
 * gathered.
 */
export function checkPatternUpdate(
  input: PatternUpdateCheckInput,
): PatternUpdateCheckReport {
  const blockers: PatternUpdateBlocker[] = [];
  const steps: PatternUpdateCheckStep[] = [];

  const contractIssues = patternSchemaCompatibilityIssues(
    input.previous,
    input.candidate,
  );
  blockers.push(
    ...contractIssues
      .map(parseContractIssue)
      .map((blocker) => annotateStreamSlot(blocker, input.candidate)),
  );
  steps.push({
    name: "pattern contract",
    status: contractIssues.length === 0 ? "pass" : "fail",
    note: contractIssues.length === 0
      ? "the candidate's argument and result contracts accept everything the running pattern's did"
      : undefined,
  });

  for (const role of ["argument", "result"] as const) {
    const stored = input.storedCfcEnvelopes[role];
    if (stored === undefined) {
      steps.push({
        name: `CFC document migration (${role})`,
        status: "not-applicable",
        note:
          `the ${role} document carries no stored CFC schema envelope, so the ` +
          `CFC merge does not run for it`,
      });
      continue;
    }
    const candidateSchema = role === "argument"
      ? input.candidate.argumentSchema
      : input.candidate.resultSchema;
    const issue = cfcSchemaMergeIssue(stored, candidateSchema);
    if (issue === undefined) {
      steps.push({
        name: `CFC document migration (${role})`,
        status: "pass",
        note: "the stored document merges onto the candidate schema",
      });
      continue;
    }
    const field = cfcNamedField(issue.message);
    blockers.push({
      class: issue.migration ? "cfc-schema-migration" : "cfc-schema-merge",
      role,
      ...(field ? { field } : {}),
      reason: issue.message,
      message: field
        ? `field \`${field}\` would become required but has no default — the ` +
          `existing ${role} document predates it and could not be read. ` +
          `Give it a \`Default<>\`, or make it optional.`
        : `${ROLE_LABEL[role]} document cannot be migrated: ${issue.message}.`,
    });
    steps.push({
      name: `CFC document migration (${role})`,
      status: "fail",
    });
  }

  if (!input.retainedLinks.ran) {
    steps.push({
      name: "retained argument links",
      status: "not-applicable",
      ...(input.retainedLinks.note ? { note: input.retainedLinks.note } : {}),
    });
  } else if (input.retainedLinks.issue === undefined) {
    steps.push({
      name: "retained argument links",
      status: "pass",
      note: "every durable link already supplied into an argument slot still " +
        "satisfies the candidate's schema for that slot",
    });
  } else {
    blockers.push({
      class: "retained-link",
      role: "argument",
      reason: input.retainedLinks.issue,
      message:
        `a durable link already supplied into an argument slot would no longer ` +
        `satisfy the candidate schema: ${input.retainedLinks.issue}.`,
    });
    steps.push({ name: "retained argument links", status: "fail" });
  }

  return {
    piece: input.piece,
    compatible: blockers.length === 0,
    steps,
    blockers,
    advisories: streamSlotAdvisories(input.previous, input.candidate),
  };
}
