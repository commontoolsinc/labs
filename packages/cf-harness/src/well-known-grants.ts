/**
 * Well-known grants: handle tokens the harness seeds into a run's handle
 * table for references every run on this console is entitled to hold, before
 * the model asks for anything. Two kinds. The session space's piece registry
 * — the discovery root behind `cf piece ls` and the shell's listings — is
 * what lets an agent find pieces to compute over without an operator handing
 * it references one by one. Beside it stand the connector handles the console
 * was launched against, so a session reaches the databases its fabric holds
 * without a caller attaching them per task.
 *
 * A grant discloses nothing by itself. What the model receives is a token and
 * a harness-authored sentence saying what the token names; the address stays
 * trusted-side in the handle table, `describe_handle` answers shape, and
 * reading anything behind the token means running a pattern over it, where
 * the CFC boundary rules as it does for every other flow.
 *
 * A connector grant's NAME is the one thing here that is read rather than
 * authored: it is the CFC class a loom instance's own table contract declares
 * for that handle's columns, which is what makes `email` and `finance` the
 * words a session is given. The reading happens in the console launcher, off
 * records on the operator's machine rather than off the fabric; what this
 * module holds it to is the name shape an operator's own `--input-cell` name
 * is held to, so a declared class cannot smuggle structure into a prompt.
 */

import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import type { HarnessFabricSession } from "./fabric-session.ts";
import { createHarnessHandleTable, mintAddressHandle } from "./handle-table.ts";
import { HANDLE_NAME_PATTERN } from "./input-cells.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
import type {
  HarnessConnectorGrantSource,
  HarnessConnectorGrantSpec,
  HarnessWellKnownGrant,
  HarnessWellKnownGrantName,
} from "./contracts/well-known-grants.ts";

export type {
  HarnessConnectorGrantSource,
  HarnessConnectorGrantSpec,
  HarnessWellKnownGrant,
  HarnessWellKnownGrantName,
} from "./contracts/well-known-grants.ts";

/**
 * Model-facing description of each fixed grant. Harness-authored text — a
 * fixed grant's description never carries anything read from the fabric or
 * from the machine.
 */
const GRANT_DESCRIPTIONS: Record<HarnessWellKnownGrantName, string> = {
  "piece-registry":
    "the space's piece registry: an array of references to every registered piece. Wire it into run_pattern `inputs` to compute over what the space holds — each entry's `$NAME` field is its display name. A name computed from protected data taints a result that reads it, so if a name-reading run is refused, fall back to a pattern that returns the entry references without reading any values.",
};

/**
 * Model-facing description of one connector grant. Harness-authored except
 * for the grant's name, which the caller has already held to
 * {@link HANDLE_NAME_PATTERN}.
 */
const connectorGrantDescription = (name: string): string =>
  `the space's \`${name}\` connector database: a read-only SQLite handle whose columns carry \`${name}\` CFC labels. Wire it into run_pattern \`inputs\` and read it with \`db.query\`; use describe_handle first to see its tables and how full each column is, because a column that is empty for every row is a filter that returns nothing.`;

/**
 * Holds one connector grant to the rule its handle is minted under: a name
 * of the shape a model may be handed, and a reference naming an entity. The
 * launcher that resolves these checks them against the record they came from
 * and says which record is wrong; this is the belt on the seeding itself, for
 * a console configured by something other than that launcher.
 *
 * @throws Error naming the connector grant and the defect.
 */
export const checkConnectorGrantSpec = (
  spec: HarnessConnectorGrantSpec,
): void => {
  if (!HANDLE_NAME_PATTERN.test(spec.name)) {
    throw new Error(
      `connector grant name must match ${HANDLE_NAME_PATTERN}, got \`${spec.name}\``,
    );
  }
  if (spec.ref.trim() === "") {
    throw new Error(`connector grant \`${spec.name}\` names no reference`);
  }
};

/**
 * Holds a grant RECORDED in run state to the rule it was minted under.
 *
 * Run state is JSON this process may not have written — a resumed run reads a
 * file — so a connector grant can arrive here having never passed the
 * launcher's checks, and its name is interpolated into model-facing text.
 * Checking it on the way out of the record is what keeps the resume path and
 * the mint path under one rule.
 *
 * @throws Error naming the grant and the defect.
 */
export const checkRecordedWellKnownGrant = (
  grant: HarnessWellKnownGrant,
): void => {
  if (grant.source === undefined) {
    return;
  }
  checkConnectorGrantSpec({
    name: grant.name,
    ref: grant.ref,
    source: grant.source,
  });
  if (
    grant.source.connection.trim() === "" || grant.source.piece.trim() === ""
  ) {
    throw new Error(
      `connector grant \`${grant.name}\` records no connection and piece`,
    );
  }
};

/**
 * One grant's name and address, before any token exists for it — the same
 * two kinds {@link HarnessWellKnownGrant} has, so the mint cannot lose track
 * of which it is holding.
 */
export type HarnessWellKnownGrantRef =
  | { name: HarnessWellKnownGrantName; ref: string; source?: undefined }
  | { name: string; ref: string; source: HarnessConnectorGrantSource };

/**
 * Resolves the canonical references behind every well-known grant. The
 * registry's comes from `session`: its resolution reads the default pattern's
 * root pointer and appends its `pieceRegistry` path, and it does not read the
 * registry contents. A connector grant's came from the console's
 * configuration and is checked rather than resolved, the console having
 * already read it off the loom instance it was launched against.
 *
 * `getPieceRegistry()` is deliberately not used here. It syncs every listed
 * piece, which is a privileged data pull that address resolution does not
 * need. In a space with no default pattern, it also returns a detached
 * placeholder that would persist as a permanently dead grant.
 *
 * @throws Error when the space has no default pattern to anchor the
 * registry, or when a connector grant is malformed; a grant that cannot name
 * a live address is refused rather than recorded.
 */
export const resolveWellKnownGrantRefs = async (
  session: HarnessFabricSession,
  connectorGrants: readonly HarnessConnectorGrantSpec[] = [],
): Promise<HarnessWellKnownGrantRef[]> => {
  const defaultPattern = await session.pieces.getDefaultPattern(false);
  if (defaultPattern === undefined) {
    throw new Error(
      "space has no default pattern to anchor the piece registry",
    );
  }
  const registryLink = defaultPattern
    .key("pieceRegistry")
    .getAsNormalizedFullLink();
  const refs: HarnessWellKnownGrantRef[] = [{
    name: "piece-registry",
    ref: createLLMFriendlyLink(registryLink, session.pieces.getSpace()),
  }];
  const names = new Set(refs.map((entry) => entry.name));
  for (const spec of connectorGrants) {
    checkConnectorGrantSpec(spec);
    if (names.has(spec.name)) {
      throw new Error(`well-known grants name \`${spec.name}\` twice`);
    }
    names.add(spec.name);
    refs.push({ name: spec.name, ref: spec.ref, source: spec.source });
  }
  return refs;
};

/**
 * Mints a handle for each resolved grant into `table` (or a fresh table
 * salted with `runId` when the run has none yet), returning the extended
 * table and the grant records for run state.
 */
export const mintWellKnownGrants = async (
  table: HarnessHandleTable | undefined,
  runId: string,
  refs: readonly HarnessWellKnownGrantRef[],
): Promise<{ table: HarnessHandleTable; grants: HarnessWellKnownGrant[] }> => {
  let current = table ?? createHarnessHandleTable(runId);
  const grants: HarnessWellKnownGrant[] = [];
  for (const grant of refs) {
    const minted = await mintAddressHandle(current, grant.ref);
    current = minted.table;
    // The entry's canonical spelling rather than the one the caller passed,
    // so the run-state record and the table entry name one reference. A
    // connector grant's arrives from a loom record and need not be canonical.
    const entry = current.entries.find(
      (candidate) => candidate.token === minted.token,
    )!;
    grants.push(
      grant.source === undefined
        ? { name: grant.name, token: minted.token, ref: entry.ref }
        : {
          name: grant.name,
          token: minted.token,
          ref: entry.ref,
          source: grant.source,
        },
    );
  }
  return { table: current, grants };
};

/**
 * The sentence announcing one grant. A connector grant is the case a
 * `source` marks, and the only one whose text names something read off the
 * machine; every other name is one this module authored, so a name that is
 * neither is a grant nobody wrote a description for and is refused rather
 * than announced as an empty phrase.
 *
 * @throws Error naming the grant whose description is missing.
 */
const grantDescription = (grant: HarnessWellKnownGrant): string => {
  if (grant.source !== undefined) {
    return connectorGrantDescription(grant.name);
  }
  // Read through `Object.hasOwn` rather than indexed directly: run state is
  // JSON this process may not have written, so a resumed record can carry a
  // name no build of this module describes, and the type that rules that out
  // for a grant we mint says nothing about one we read back.
  if (!Object.hasOwn(GRANT_DESCRIPTIONS, grant.name)) {
    throw new Error(`no description for well-known grant \`${grant.name}\``);
  }
  return GRANT_DESCRIPTIONS[grant.name];
};

/**
 * The context message announcing `grants` to the model: one line per grant,
 * each pairing the token with its description. An empty grant list yields no
 * message at all rather than an empty header.
 */
export const wellKnownGrantsContextMessage = (
  grants: readonly HarnessWellKnownGrant[],
): string | undefined => {
  if (grants.length === 0) {
    return undefined;
  }
  return [
    "Granted references for this run's Fabric space:",
    ...grants.map((grant) => `- ${grant.token} — ${grantDescription(grant)}`),
    "Use describe_handle on a granted token to see its shape before authoring against it.",
  ].join("\n");
};
