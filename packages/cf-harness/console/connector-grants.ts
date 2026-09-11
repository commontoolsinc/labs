/**
 * The connector handles a loom instance has injected into its space, read as
 * grants the console seeds into every session it runs.
 *
 * Two of that instance's records decide a grant, and neither is enough alone.
 * `sqlite-injection/handles.json` — the receipt the daemon's reconciler writes,
 * and what `loom connector handles` prints — says which handles exist and what
 * each one's reference is, but records no label class. `pieces.json` declares
 * each connector piece's `sqlite_sources`, whose table contract carries the
 * per-column `ifc` the daemon seeded, and that is where a handle's CFC class is
 * written down. Joining them on the piece and connection loom names in both is
 * what lets a grant be called `email` or `finance` rather than by a connection
 * id that means nothing to a model.
 *
 * A handle whose class cannot be read is not guessed at and not granted: it is
 * returned as unnamed, with the reason, for the launcher to print. A console
 * that silently held one fewer reference than its report claimed would be the
 * failure this whole launch path exists to prevent.
 */

import { HANDLE_NAME_PATTERN } from "../src/input-cells.ts";
import { parseHandleRef } from "../src/handle-table.ts";
import type { HarnessConnectorGrantSpec } from "../src/contracts/well-known-grants.ts";
import { HARNESS_WELL_KNOWN_GRANT_NAMES } from "../src/contracts/well-known-grants.ts";

/** The CFC atom type whose `class` names what a column holds. */
const RESOURCE_ATOM_TYPE = "https://commonfabric.org/cfc/atom/Resource";

/**
 * Names the harness grants on its own. A declared class landing on one of
 * these is reported here rather than passed on, because the seeding refuses a
 * name twice and would take every session on the console down with it.
 */
const RESERVED_GRANT_NAMES: ReadonlySet<string> = new Set<string>(
  HARNESS_WELL_KNOWN_GRANT_NAMES,
);

/** The loom records a connector grant is resolved from. */
export interface LoomConnectorRecords {
  /** The verbatim `sqlite-injection/handles.json`, when the file exists. */
  handlesJson?: string;

  /** The absolute path it was read from, for error text. */
  handlesJsonPath: string;

  /** The verbatim `pieces.json`. */
  piecesJson: string;

  /** The absolute path it was read from, for error text. */
  piecesJsonPath: string;
}

/** A handle the records name but could not be granted, and why. */
export interface UnnamedConnectorHandle {
  connection: string;
  piece: string;
  reason: string;
}

/** What the records yielded: the grants to seed, and what they left out. */
export interface ResolvedConnectorGrants {
  grants: HarnessConnectorGrantSpec[];
  unnamed: UnnamedConnectorHandle[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * The distinct CFC classes one `sqlite_sources` entry's table contract
 * declares, in the order the contract states them. Reads only the `Resource`
 * atoms of each column's `ifc.confidentiality`: the owner principal beside
 * them names who the columns belong to rather than what they hold, and the
 * `ConnectorObserved` integrity beside that is provenance, so neither answers
 * the question a grant's name asks.
 */
export const declaredClasses = (source: Record<string, unknown>): string[] => {
  const tables = asRecord(source.tables) ?? {};
  const classes: string[] = [];
  for (const table of Object.values(tables)) {
    const properties = asRecord(asRecord(table)?.properties) ?? {};
    for (const column of Object.values(properties)) {
      const confidentiality = asRecord(asRecord(column)?.ifc)?.confidentiality;
      if (!Array.isArray(confidentiality)) continue;
      for (const atom of confidentiality) {
        const record = asRecord(atom);
        if (record?.type !== RESOURCE_ATOM_TYPE) continue;
        const declared = asNonEmptyString(record.class);
        if (declared !== undefined && !classes.includes(declared)) {
          classes.push(declared);
        }
      }
    }
  }
  return classes;
};

/**
 * The key one injected handle is identified by on both sides of the join: the
 * piece that carries it and the connection it belongs to. Joined on `\0`,
 * which neither a loom piece name nor a connection id can hold, so no pair of
 * names collides by spelling one key two ways.
 */
const handleKey = (piece: string, connection: string): string =>
  `${piece}\0${connection}`;

/**
 * The `sqlite_sources` entries `pieces.json` declares, keyed by
 * {@link handleKey}. The same pair keys the receipt's entries, so this is the
 * whole of the join.
 */
const sourcesByHandle = (
  piecesJson: string,
  piecesJsonPath: string,
): Map<string, Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(piecesJson);
  } catch (error) {
    throw new Error(
      `\`${piecesJsonPath}\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const pieces = asRecord(parsed)?.pieces;
  const sources = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(pieces)) {
    return sources;
  }
  for (const entry of pieces) {
    const piece = asRecord(entry);
    const name = asNonEmptyString(piece?.name);
    if (piece === undefined || name === undefined) continue;
    if (!Array.isArray(piece.sqlite_sources)) continue;
    for (const candidate of piece.sqlite_sources) {
      const source = asRecord(candidate);
      const connection = asNonEmptyString(source?.connection_id);
      if (source !== undefined && connection !== undefined) {
        sources.set(handleKey(name, connection), source);
      }
    }
  }
  return sources;
};

/**
 * Resolves the grants a console launched against these records seeds, and the
 * handles it could not name.
 *
 * An absent receipt is no handles rather than an error: the daemon writes it
 * on its next reconcile pass, so a fabric that has never injected one has
 * nothing to read and nothing is wrong.
 *
 * @throws Error naming the record that does not parse. A malformed receipt is
 * not "no connectors": it is a record whose meaning is unknown, and a console
 * that started anyway would run every session one grant short while reporting
 * none missing.
 */
export const resolveConnectorGrants = (
  records: LoomConnectorRecords,
): ResolvedConnectorGrants => {
  if (records.handlesJson === undefined) {
    return { grants: [], unnamed: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(records.handlesJson);
  } catch (error) {
    throw new Error(
      `\`${records.handlesJsonPath}\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const document = asRecord(parsed);
  if (document === undefined) {
    throw new Error(
      `\`${records.handlesJsonPath}\` does not hold a JSON object; loom ` +
        `writes {schema_version, written_at, space, handles}`,
    );
  }
  const handles = document.handles;
  if (handles === undefined) {
    return { grants: [], unnamed: [] };
  }
  if (!Array.isArray(handles)) {
    throw new Error(
      `\`${records.handlesJsonPath}\` holds a \`handles\` that is not an array`,
    );
  }

  // The space the receipt itself names, which is the instance's. A handle
  // reference that carries a different one is not this instance's to grant.
  const receiptSpace = asNonEmptyString(document.space);
  const sources = sourcesByHandle(records.piecesJson, records.piecesJsonPath);
  const grants: HarnessConnectorGrantSpec[] = [];
  const unnamed: UnnamedConnectorHandle[] = [];
  const claimedBy = new Map<string, string>();
  for (const entry of handles) {
    const handle = asRecord(entry);
    const connection = asNonEmptyString(handle?.connection_id) ?? "(unnamed)";
    const piece = asNonEmptyString(handle?.piece) ?? "(unnamed)";
    const skip = (reason: string): void => {
      unnamed.push({ connection, piece, reason });
    };
    const ref = asNonEmptyString(handle?.handle_ref);
    if (ref === undefined) {
      skip("the receipt records no `handle_ref` for it");
      continue;
    }
    let link;
    try {
      link = parseHandleRef(ref);
    } catch (error) {
      skip(
        `its \`handle_ref\` does not parse: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    // A reference may carry its own space, and a grant is minted into the
    // session's. One naming another space would seed every session on this
    // console with a reference outside the authority the console runs under —
    // the boundary `--input-cell` is already held to, drawn here because the
    // receipt is a file rather than something an operator typed.
    if (link.space !== undefined && link.space !== receiptSpace) {
      // Fails closed when the receipt names no space of its own: a reference
      // that carries one is a claim about where it points, and with nothing to
      // check it against there is no reading on which granting it is safe.
      skip(
        receiptSpace === undefined
          ? `its \`handle_ref\` names space \`${link.space}\`, and the receipt ` +
            `names no space to check it against`
          : `its \`handle_ref\` names space \`${link.space}\`, which is not the ` +
            `space the receipt was written for`,
      );
      continue;
    }
    const source = sources.get(handleKey(piece, connection));
    if (source === undefined) {
      skip(
        `\`${records.piecesJsonPath}\` declares no \`sqlite_sources\` entry ` +
          `for this piece and connection`,
      );
      continue;
    }
    const classes = declaredClasses(source);
    if (classes.length === 0) {
      skip("its declared table contract carries no CFC class");
      continue;
    }
    if (classes.length > 1) {
      skip(
        `its declared table contract carries ${classes.length} CFC classes ` +
          `(${classes.join(", ")}), so one name would not say what it holds`,
      );
      continue;
    }
    const name = classes[0]!;
    if (RESERVED_GRANT_NAMES.has(name)) {
      skip(
        `its declared CFC class \`${name}\` is a name the harness already grants`,
      );
      continue;
    }
    if (!HANDLE_NAME_PATTERN.test(name)) {
      skip(
        `its declared CFC class \`${name}\` is not a name a model may be handed`,
      );
      continue;
    }
    const claimed = claimedBy.get(name);
    if (claimed !== undefined) {
      skip(
        `its declared CFC class \`${name}\` is already the grant connection ` +
          `\`${claimed}\` was named by`,
      );
      continue;
    }
    claimedBy.set(name, connection);
    grants.push({ name, ref, source: { connection, piece } });
  }
  return { grants, unnamed };
};

/**
 * The grants a launcher resolved, read back out of the environment variable
 * it passed them in. The launcher and the server are two processes, so the
 * variable is the whole of what crosses between them, and a value that does
 * not parse is a startup failure rather than zero grants: a console that came
 * up holding none while its launcher reported two is the silent
 * misconfiguration this path exists to rule out.
 *
 * @throws Error naming the variable and the defect.
 */
export const parseConnectorGrants = (
  json: string | undefined,
): HarnessConnectorGrantSpec[] => {
  if (json === undefined || json.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `\`CF_HARNESS_CONNECTOR_GRANTS\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "`CF_HARNESS_CONNECTOR_GRANTS` must hold an array of grants",
    );
  }
  return parsed.map((entry) => {
    const record = asRecord(entry);
    const name = asNonEmptyString(record?.name);
    const ref = asNonEmptyString(record?.ref);
    const source = asRecord(record?.source);
    const connection = asNonEmptyString(source?.connection);
    const piece = asNonEmptyString(source?.piece);
    if (
      name === undefined || ref === undefined || connection === undefined ||
      piece === undefined
    ) {
      throw new Error(
        "each `CF_HARNESS_CONNECTOR_GRANTS` entry needs a name, a ref, and " +
          "a source naming its connection and piece",
      );
    }
    if (!HANDLE_NAME_PATTERN.test(name)) {
      throw new Error(
        `\`CF_HARNESS_CONNECTOR_GRANTS\` names a grant \`${name}\`, which ` +
          `must match ${HANDLE_NAME_PATTERN}`,
      );
    }
    // Held to the same rule the mint holds it to, so a reference that would
    // fail the first session fails the startup instead. An inherited variable
    // is the case this catches: the launcher checked what it resolved, and a
    // console started another way was handed whatever was in the environment.
    try {
      parseHandleRef(ref);
    } catch (error) {
      throw new Error(
        `\`CF_HARNESS_CONNECTOR_GRANTS\` grant \`${name}\` names a reference ` +
          `that does not parse: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    return { name, ref, source: { connection, piece } };
  });
};
