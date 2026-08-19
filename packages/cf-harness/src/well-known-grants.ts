/**
 * Well-known grants: handle tokens the harness seeds into a run's handle
 * table for references every Fabric-configured run is entitled to hold,
 * before the model asks for anything. The first grant is the session space's
 * piece registry — the discovery root behind `cf piece ls` and the shell's
 * listings — which is what lets an agent find pieces to compute over without
 * an operator handing it references one by one. The list is designed to
 * grow: the identity's profile is the expected next entry.
 *
 * A grant discloses nothing by itself. What the model receives is a token
 * and a fixed, harness-authored sentence saying what the token names; the
 * address stays trusted-side in the handle table, `describe_handle` answers
 * shape, and reading anything behind the token means running a pattern over
 * it, where the CFC boundary rules as it does for every other flow.
 */

import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import type { HarnessFabricSession } from "./fabric-session.ts";
import { createHarnessHandleTable, mintAddressHandle } from "./handle-table.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
import type {
  HarnessWellKnownGrant,
  HarnessWellKnownGrantName,
} from "./contracts/well-known-grants.ts";

export type {
  HarnessWellKnownGrant,
  HarnessWellKnownGrantName,
} from "./contracts/well-known-grants.ts";

/**
 * Model-facing description of each grant. Fixed harness-authored text — a
 * grant's description never carries anything read from the fabric.
 */
const GRANT_DESCRIPTIONS: Record<HarnessWellKnownGrantName, string> = {
  "piece-registry":
    "the space's piece registry: an array of references to every registered piece. Wire it into run_pattern `inputs` to compute over what the space holds — each entry's `$NAME` field is its display name. A name computed from protected data taints a result that reads it, so if a name-reading run is refused, fall back to a pattern that returns the entry references without reading any values.",
};

/**
 * Resolves the canonical references behind every well-known grant through
 * `session`. Each resolution is a metadata read — the registry cell's own
 * address — not a read of what the registry lists.
 */
export const resolveWellKnownGrantRefs = async (
  session: HarnessFabricSession,
): Promise<{ name: HarnessWellKnownGrantName; ref: string }[]> => {
  const registry = await session.pieces.getPieceRegistry();
  return [{
    name: "piece-registry",
    ref: createLLMFriendlyLink(
      registry.getAsNormalizedFullLink(),
      session.pieces.getSpace(),
    ),
  }];
};

/**
 * Mints a handle for each resolved grant into `table` (or a fresh table
 * salted with `runId` when the run has none yet), returning the extended
 * table and the grant records for run state.
 */
export const mintWellKnownGrants = async (
  table: HarnessHandleTable | undefined,
  runId: string,
  refs: readonly { name: HarnessWellKnownGrantName; ref: string }[],
): Promise<{ table: HarnessHandleTable; grants: HarnessWellKnownGrant[] }> => {
  let current = table ?? createHarnessHandleTable(runId);
  const grants: HarnessWellKnownGrant[] = [];
  for (const { name, ref } of refs) {
    const minted = await mintAddressHandle(current, ref);
    current = minted.table;
    grants.push({ name, token: minted.token, ref });
  }
  return { table: current, grants };
};

/**
 * The context message announcing `grants` to the model: one line per grant,
 * each pairing the token with its fixed description. An empty grant list
 * yields no message at all rather than an empty header.
 */
export const wellKnownGrantsContextMessage = (
  grants: readonly HarnessWellKnownGrant[],
): string | undefined => {
  if (grants.length === 0) {
    return undefined;
  }
  return [
    "Granted references for this run's Fabric space:",
    ...grants.map((grant) =>
      `- ${grant.token} — ${GRANT_DESCRIPTIONS[grant.name]}`
    ),
    "Use describe_handle on a granted token to see its shape before authoring against it.",
  ].join("\n");
};
