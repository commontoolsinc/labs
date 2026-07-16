import type { NormalizedFullLink } from "../link-utils.ts";

/**
 * Builtins whose external work has a server-side implementation in the first
 * server-primary rollout. Keep this list deliberately exact: a raw module only
 * receives this identity when it was resolved through the canonical builtin
 * registry ref, never from caller-controlled debug metadata.
 */
export const SERVER_EXECUTABLE_BUILTIN_IDS = [
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  "generateText",
  "generateObject",
] as const;

export type ServerExecutableBuiltinId =
  typeof SERVER_EXECUTABLE_BUILTIN_IDS[number];

const SERVER_EXECUTABLE_BUILTIN_SET = new Set<string>(
  SERVER_EXECUTABLE_BUILTIN_IDS,
);

export function isServerExecutableBuiltinId(
  value: unknown,
): value is ServerExecutableBuiltinId {
  return typeof value === "string" &&
    SERVER_EXECUTABLE_BUILTIN_SET.has(value);
}

export function serverBuiltinImplementationHash(
  id: ServerExecutableBuiltinId,
): string {
  return `cf:builtin/${id}:server-v1`;
}

/**
 * Static implementation identity for a canonical builtin resolved through the
 * registry ref. Raw builtins are host functions with no SES provenance, so
 * `applyImplementationHash` cannot stamp them; without this their fingerprint
 * falls to an `action:…` shape that servability rejects as
 * `untrusted-implementation`. The `:v1` shape is deliberately distinct from
 * `serverBuiltinImplementationHash`'s `:server-v1`: identity ("this action IS
 * canonical builtin <id>") must never be conflated with "the server has a
 * native implementation of this external effect" — run.ts keys its
 * server-builtin effect-descriptor path on the exact `:server-v1` fingerprint.
 * The caller supplies the id ONLY from the canonical registry ref, never from
 * caller-controlled debug metadata.
 */
export function builtinImplementationHash(id: string): string {
  return `cf:builtin/${id}:v1`;
}

/** Runner-authored static portion of a supported builtin's action surface. */
export interface ServerBuiltinActionDescriptor {
  readonly version: 1;
  readonly id: ServerExecutableBuiltinId;
  readonly piece: NormalizedFullLink;
  readonly reads: readonly NormalizedFullLink[];
  readonly writes: readonly NormalizedFullLink[];
  /** Stable array populated by the builtin when it mints internal cells. */
  readonly runtimeWrites: readonly NormalizedFullLink[];
  readonly directOutputs: readonly NormalizedFullLink[];
}
