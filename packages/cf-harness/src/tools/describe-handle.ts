import type { JSONSchema } from "@commonfabric/api";
import { columnDeclaresIfc, isSqliteDbRef } from "@commonfabric/memory/v2";
import type { Cell } from "@commonfabric/runner";
import { cfcLabelViewForCellFailClosed } from "@commonfabric/runner/cfc";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessFabricSession } from "../fabric-session.ts";
import { resolveHandleToken } from "../handle-table.ts";
import { schemaShapeOnly } from "../schema-shape.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface DescribeHandleToolInput {
  token: string;
}

export interface DescribeHandleToolOutput {
  outputId: string;

  /** The token as asked about, echoed so a reply stands on its own. */
  token: string;

  /** Whether this run's handle table holds the token. */
  known: boolean;

  /** Whether a schema was found to report, from either source. */
  hasSchema: boolean;

  /** Named capability refusal for a known but non-describable handle. */
  error?: string;

  /**
   * The reported schema: fabric-declared, or harness-derived, whichever
   * answered first in that order.
   */
  schema?: JSONSchema;

  /**
   * Path segments of the referent within its piece — which field of which
   * piece the token names. Read off the entry's already-parsed reference, so
   * it costs nothing and reveals no value.
   */
  path?: string[];

  /**
   * The CFC labels the referent carries, one per labelled path within it.
   * Absent when the run has no session to read them through; an empty list
   * says the space holds none, which is a different answer.
   */
  labels?: DescribeHandleLabel[];

  /**
   * The table contract of a referent that is a SQLite database, reported
   * where the referent declares no schema of its own. Without it a database
   * handed to a run is indistinguishable from an opaque value, and the code
   * an agent can write over it is code that treats it as one.
   */
  database?: DescribeHandleDatabase;
}

/**
 * What a SQLite database handle states about itself: the shape of a row of
 * each of its tables, and what handling each column demands. Rows are not
 * part of it. They live in the database rather than in the handle, and
 * nothing here opens one — the tables are the contract the database was
 * created under, which is a declaration in exactly the sense a schema is.
 */
export interface DescribeHandleDatabase {
  /**
   * One property per table, whose own properties are that table's columns
   * with their declared types. Reduced like every other disclosed schema, so
   * column annotations, prose and defaults do not ride out on it, and the
   * table- and column-name channels are bounded exactly as any other
   * property-name channel is.
   */
  tables: JSONSchema;

  /**
   * The columns that declare a CFC label, each addressed by its table name
   * and its column name. Atom types and nothing else, the same line
   * {@link DescribeHandleLabel} draws for a cell's own labels — so an entry
   * with no atoms says the column declares a label this cannot name, which is
   * a different fact from a column that declares none and has no entry.
   */
  labels: DescribeHandleLabel[];
}

/** The label at one path inside a referent, as atom types and nothing else. */
export interface DescribeHandleLabel {
  /** Path within the referent, absent for the referent itself. */
  path?: string[];

  /**
   * Confidentiality requirements: one entry per clause, each clause listing
   * the atom types that satisfy it. A clause of several types is satisfied by
   * any one of them, so the nesting is the requirement rather than a
   * formatting choice.
   */
  confidentiality: string[][];

  /** Integrity atom types, all of which the value carries. */
  integrity: string[];
}

/**
 * Describes the SHAPE of a handle's referent and nothing else: property
 * names, types, nesting, and required-ness. No datum is ever reported, so a
 * reply here says what a reference is, never what it holds. This is what lets
 * an agent write code over a reference it was handed
 * — you cannot compute over data whose shape you do not know — and what lets
 * an orchestrator verify a chain of transformations without reading the data
 * flowing through it.
 *
 * Posture, stated plainly. The policy on disclosing shape is permissive and
 * fixed: any run that holds the token gets an answer, and there is no setting
 * that says otherwise. That is defensible on the same ground declassification
 * stands on elsewhere, and it is the contract patterns already work under
 * internally: you cannot see the data, you can only describe the data flow.
 *
 * Two shapes can answer, in this order:
 *
 * 1. The schema the referent DECLARES in the fabric, read through the run's
 *    session when it has one. A piece's document schema is the result schema
 *    of the pattern behind it, which is the shape an agent holding a handle to
 *    that piece would be wiring into a pattern of its own. The read is of the
 *    document's declared schema and of nothing else; the referent's value is
 *    not read, and a reference outside the session's own space is not
 *    followed.
 * 2. The schema the mint recorded out of the harness's OWN work — the result
 *    schema of a pattern this harness compiled and ran, marked
 *    `schemaSource: "harness"` on the entry.
 *
 * Either way what leaves this tool is STRUCTURE. A JSON Schema is a place a
 * value can hide — `const`, `enum`, `default` and `examples` carry values
 * outright, and `title`, `description` and `pattern` carry free text whoever
 * authored the schema chose — and a fabric-declared schema was authored by
 * someone other than this run, quite possibly a person. So every disclosed
 * schema is rebuilt by {@link schemaShapeOnly} from an allowlist of structural
 * keywords, at every depth, before it is reported. Prose and values do not
 * cross that line, and neither do definition names, which are replaced by
 * opaque ones. Property names do cross it, because nothing can be written over
 * data without them — so they are the one channel of author-chosen text this
 * tool knowingly accepts.
 *
 * A referent that declares no schema gets a third read, and it is the one
 * place this tool reads a value. Some referents state their contract in their
 * value rather than in their metadata, and a SQLite database handle is the
 * case that matters: what the handle holds is the set of table schemas the
 * database was created under, and the rows live in the database file, which
 * nothing here opens. So where no schema was declared and the value is a
 * database handle, its tables are reported as {@link DescribeHandleDatabase}
 * — reduced by the same {@link schemaShapeOnly} pass, with the columns' own
 * `ifc` annotations reported beside them as labels rather than left on the
 * schema. Without that a database reads as an opaque value, and the code an
 * agent writes over an opaque value is code that treats it as one. The read
 * is conditional on there being no declared schema, so a referent that states
 * its own shape is never opened.
 *
 * A run with no fabric session still answers from its own table, so shape
 * stays inspectable in every run that has handles at all.
 *
 * Labels answer beside the shape, from the same synced document, and only
 * where a session read it: a cell's CFC labels live in its own metadata
 * rather than on its schema, so shape and labels are two reads of one
 * document and a run can hold one without the other. What crosses is atom
 * TYPES — the URLs naming what a value requires and what it carries — and not
 * an atom's other fields, which say what a label was computed FROM. That is
 * the same line the shape disclosure draws: a run may know what it is holding
 * and what handling that demands, and may not read what is behind it. A read
 * that fails is reported as a label rather than as no label, so a cell whose
 * metadata could not be interpreted does not read as public.
 */
export const describeHandleToolDescriptor: HarnessToolDescriptor = {
  toolId: "describe_handle",
  title: "Describe Handle",
  description:
    "Report the shape of a general handle's referent and the CFC labels it carries: its recorded schema, path and label atom types, never its data. A referent that is a SQLite database reports its tables instead of a schema, under `database`: the columns of each table with their types, and the labels those columns carry. Read such a referent with `db.query` over the handle rather than as a value. A capability-restricted handle returns a named refusal. Use it to check that a reference is the kind of thing a step expects, and what handling it demands, before passing it on.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "A handle token of the form cfh:a:<suffix>.",
      },
    },
    required: ["token"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      token: { type: "string" },
      known: { type: "boolean" },
      hasSchema: { type: "boolean" },
      schema: {},
      path: { type: "array", items: { type: "string" } },
      labels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "array", items: { type: "string" } },
            confidentiality: {
              type: "array",
              items: { type: "array", items: { type: "string" } },
            },
            integrity: { type: "array", items: { type: "string" } },
          },
          required: ["confidentiality", "integrity"],
          additionalProperties: false,
        },
      },
      database: {
        type: "object",
        properties: {
          tables: {},
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "array", items: { type: "string" } },
                confidentiality: {
                  type: "array",
                  items: { type: "array", items: { type: "string" } },
                },
                integrity: { type: "array", items: { type: "string" } },
              },
              required: ["confidentiality", "integrity"],
              additionalProperties: false,
            },
          },
        },
        required: ["tables", "labels"],
        additionalProperties: false,
      },
      error: { type: "string" },
    },
    required: ["outputId", "token", "known", "hasSchema"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["handle", "shape"],
};

/**
 * Path segments of `ref`, or `undefined` when the reference names a piece
 * root or does not parse. Parsing is the only work done here — no lookup, no
 * read.
 */
const pathSegmentsOf = (ref: string): string[] | undefined => {
  try {
    const parsed = parseLLMFriendlyLink(
      ref.startsWith("/") ? ref : `/${ref}`,
    );
    return parsed.path.length > 0 ? parsed.path.map(String) : undefined;
  } catch {
    return undefined;
  }
};

/** The type an atom names: its `type` field, or the whole of a string atom. */
const atomType = (atom: unknown): string | undefined => {
  if (typeof atom === "string") {
    return atom;
  }
  const type = (atom as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : undefined;
};

/**
 * One confidentiality clause's alternatives, as atom types. A bare atom is
 * its own single alternative, and a clause whose atoms this cannot name is
 * dropped rather than reported as an empty — that is, unconditional —
 * requirement.
 */
const clauseTypes = (clause: unknown): string[] => {
  const alternatives = (clause as { anyOf?: unknown } | null)?.anyOf;
  return (Array.isArray(alternatives) ? alternatives : [clause])
    .map(atomType)
    .filter((type): type is string => type !== undefined);
};

/**
 * One stored label as atom types alone. Only atom TYPES cross: an atom's
 * other fields are whatever minted it wrote, and a label is disclosed here so
 * a run can tell what it is holding, not so it can read what a label was
 * computed from. The same projection serves a cell's own labels and a
 * database column's `ifc`, which are the same structure stored in two places.
 */
const labelAtomTypes = (
  label: { confidentiality?: unknown[]; integrity?: unknown[] },
): Omit<DescribeHandleLabel, "path"> => ({
  confidentiality: (label.confidentiality ?? [])
    .map(clauseTypes)
    .filter((clause) => clause.length > 0),
  integrity: (label.integrity ?? [])
    .map(atomType)
    .filter((type): type is string => type !== undefined),
});

/** The labels the referent carries, read live through the session. */
const describedLabels = (cell: Cell<unknown>): DescribeHandleLabel[] =>
  (cfcLabelViewForCellFailClosed(cell)?.entries ?? []).map((entry) => ({
    ...(entry.path.length > 0 ? { path: [...entry.path] } : {}),
    ...labelAtomTypes(entry.label),
  }));

/**
 * The table contract `value` states, or nothing when it is not a SQLite
 * database handle or names no tables. A handle's tables are the schemas the
 * database was created under — a declaration, in the same sense a document's
 * schema is one — so what leaves here is the same structure every other
 * disclosure is reduced to, plus the columns' labels.
 */
const describedDatabase = (
  value: unknown,
): DescribeHandleDatabase | undefined => {
  if (!isSqliteDbRef(value)) {
    return undefined;
  }
  const tables = value.tables;
  if (tables === null || typeof tables !== "object") {
    return undefined;
  }
  const labels: DescribeHandleLabel[] = [];
  for (const [table, spec] of Object.entries(tables)) {
    const columns =
      (spec as { properties?: Record<string, { ifc?: unknown }> } | null)
        ?.properties;
    for (const [column, declaration] of Object.entries(columns ?? {})) {
      const ifc = declaration?.ifc;
      if (columnDeclaresIfc(ifc)) {
        labels.push({
          path: [table, column],
          ...labelAtomTypes(ifc as Parameters<typeof labelAtomTypes>[0]),
        });
      }
    }
  }
  // Wrapping the tables as one schema's properties is what puts the table
  // names through the same bound and the same reduction the column names
  // already go through: a table is an object whose properties are its
  // columns, which is what the reduction already knows how to walk.
  return {
    tables: schemaShapeOnly({
      type: "object",
      properties: tables as Record<string, JSONSchema>,
    }),
    labels,
  };
};

/**
 * The schema declared for the referent at `path`, or nothing when none is.
 * A document's declared schema narrowed by a path is a walk over the schema
 * rather than a read of the data, so nothing here goes near a value; the
 * referent's own schema is the last resort, since with no declared schema
 * there is nothing to walk.
 */
const declaredSchema = async (
  root: Cell<unknown>,
  referent: Cell<unknown>,
  path: readonly (string | number)[],
  documentSchema: JSONSchema | undefined,
): Promise<JSONSchema | undefined> => {
  if (path.length === 0) {
    return documentSchema ?? root.schema;
  }
  if (documentSchema !== undefined) {
    return ((root.asSchema(documentSchema) as Cell<unknown>).key(
      ...path,
    ) as Cell<unknown>).schema;
  }
  await referent.sync();
  return referent.schema;
};

/**
 * The referent's table contract as a fragment to spread, empty where it has
 * none. The read is permissive-schema and resolving because a handle written
 * before the sqlite builtin stored it inline can hold links where its table
 * schemas belong, and the SqliteDb shape declares no properties, so a shaped
 * read would reduce the handle to `{}`.
 */
const databaseOf = (
  referent: Cell<unknown>,
): Pick<DescribedReferent, "database"> => {
  const database = describedDatabase(
    referent.asSchema({ type: "object", additionalProperties: true }).get(),
  );
  return database === undefined ? {} : { database };
};

/** What the session can state about `ref`: its declared shape, and its labels. */
interface DescribedReferent {
  schema?: JSONSchema;
  labels?: DescribeHandleLabel[];
  database?: DescribeHandleDatabase;
}

/**
 * What `ref` DECLARES in the session's fabric, or nothing when the session
 * cannot state it. A document's declared schema lives in its metadata — for a
 * piece it is the result schema of the pattern behind it — and a reference
 * into the document narrows that schema by its path, which is a walk over the
 * schema rather than a read of the data. The labels come off the same synced
 * document, rebased onto the referent's own path, so one read answers both.
 *
 * A reference outside the session's own space is not followed: the session's
 * authority ends at its space, the same boundary `run_pattern` draws over its
 * inputs. Anything that goes wrong — an unparseable reference, a document
 * that does not exist, a path the schema does not describe — answers nothing,
 * since what the session cannot state is reported as absent rather than as a
 * failed call.
 */
const describeInFabric = async (
  session: HarnessFabricSession,
  ref: string,
): Promise<DescribedReferent> => {
  const { pieces } = session;
  const space = pieces.getSpace();
  let link;
  try {
    link = parseLLMFriendlyLink(ref.startsWith("/") ? ref : `/${ref}`, space);
  } catch {
    return {};
  }
  if (link.space !== space) {
    return {};
  }
  try {
    const root = pieces.runtime.getCellFromLink({
      ...link,
      path: [],
      schema: undefined,
    });
    await root.sync();
    // The labels are the synced document's own metadata, narrowed to the
    // referent's path by the view, so they cost no read beyond the one the
    // shape already needed.
    const referent =
      (link.path.length === 0 ? root : root.key(...link.path)) as Cell<unknown>;
    const labels = describedLabels(referent);
    const documentSchema = root.getMetaRaw("schema") as JSONSchema | undefined;
    const declared = await declaredSchema(
      root,
      referent,
      link.path,
      documentSchema,
    );
    if (declared !== undefined) {
      return { labels, schema: declared };
    }
    // Nothing was declared, so the referent's own value is the only place a
    // contract can still be stated, and a database handle states one there.
    return { labels, ...databaseOf(referent) };
  } catch {
    return {};
  }
};

export const describeHandleTool: HarnessToolDefinition<
  DescribeHandleToolInput,
  DescribeHandleToolOutput
> = {
  descriptor: describeHandleToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("describe_handle");
    const token = typeof input.token === "string" ? input.token.trim() : "";
    const entry = context.handleTable === undefined
      ? undefined
      : resolveHandleToken(context.handleTable, token);
    if (entry === undefined) {
      // An unknown token is an ordinary answer, not a failure: a token from
      // another run, or one the model invented, simply names nothing here.
      return {
        outputId,
        token,
        known: false,
        hasSchema: false,
      };
    }
    if (entry.capability === "skill-context") {
      return {
        outputId,
        token: entry.token,
        known: true,
        hasSchema: false,
        error:
          "describe_handle cannot consume a skill-context handle; only delegate_task skillHandle can",
      };
    }
    const path = pathSegmentsOf(entry.ref);
    // What the referent DECLARES answers first, because the question asked is
    // what is at this address and the document at it is the authority on
    // that. A recorded schema is second-best — it is what whichever step
    // minted the handle happened to know — and it answers when the run has no
    // session, or when the session can state no shape for the address.
    let described: DescribedReferent = {};
    if (context.getFabricSession !== undefined) {
      try {
        described = await describeInFabric(
          await context.getFabricSession(),
          entry.ref,
        );
      } catch {
        // A session that cannot be established leaves the record to answer,
        // which is what a run without one does anyway.
      }
    }
    const schema = described.schema ??
      (entry.schemaSource === "harness" ? entry.schema : undefined);
    // Structure only: whatever the source, the reported schema is rebuilt
    // from structural keywords, so no value and no prose rides out on it.
    const disclosed = schema === undefined
      ? undefined
      : schemaShapeOnly(schema);
    return {
      outputId,
      token: entry.token,
      known: true,
      hasSchema: disclosed !== undefined,
      ...(disclosed !== undefined ? { schema: disclosed } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(described.labels !== undefined ? { labels: described.labels } : {}),
      ...(described.database !== undefined
        ? { database: described.database }
        : {}),
    };
  },
};
