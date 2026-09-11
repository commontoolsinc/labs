/**
 * What a pattern's computation picks up from the rows of a real query result.
 *
 * A `sqliteQuery` result is a container holding one link per row, and the
 * column labels a db declares ride onto the row documents rather than onto the
 * container: every entry the container carries is `origin: "link"` with a
 * `LinkReference` atom and no confidentiality of its own. So what a reader
 * derives turns on whether it opened a row, and these two arms are that split
 * — one computation reads a field off every row, the other reads the row
 * count and nothing else.
 *
 * The db is declared and seeded through the same path a connector store
 * reaches a pattern by: per-column `ifc` on the table contract, rows written
 * through `recordSqliteWrite`, and the query run by the builtin inside a
 * pattern. Seeding the container by hand instead would decide the question in
 * the fixture.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import type { FabricValue } from "@commonfabric/data-model";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-flow-query-rows");
const space = signer.did();

/** The class the db's own column contract declares, as a connector's does. */
const ROW_CLASS = "row-class";

const SELECT_ROWS = "SELECT id, subject FROM emails ORDER BY id";

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

interface QueryRow {
  id: number;
  subject: string;
}

interface QueryState {
  pending?: boolean;
  result?: QueryRow[];
}

describe("CFC flow labels: the rows of a query result", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica!.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const derivedConfidentiality = (id: string): string[] =>
    entriesOf(id)
      .filter((e) => e.origin === "derived")
      .flatMap((e) => e.label.confidentiality ?? []);

  /** A db whose `subject` column declares a class, the way a connector's does. */
  const labeledDb = (): SqliteDbRef => ({
    id: `of:query-rows-${crypto.randomUUID()}`,
    tables: {
      emails: {
        type: "object",
        properties: {
          id: { type: "integer", sqlType: "integer primary key" },
          subject: {
            type: "string",
            sqlType: "text",
            ifc: { confidentiality: [ROW_CLASS] },
          },
        },
        required: [],
      },
    } as unknown as SqliteDbRef["tables"],
  });

  const seed = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<void> => {
    const tx = runtime!.edit();
    tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
  };

  /**
   * Runs the query and `summarize` over it in one pattern, and returns the
   * confidentiality a consumer of the summary derives — which is what the
   * piece a run leaves behind would carry.
   */
  const summaryConfidentiality = async (
    cause: string,
    summarize: (query: QueryState) => unknown,
  ): Promise<{ confidentiality: string[]; summary: unknown }> => {
    const { commonfabric: cf } = createTrustedBuilder(runtime!);
    const { lift } = cf as unknown as {
      lift: (
        fn: (value: QueryState) => unknown,
        argumentSchema?: unknown,
      ) => (value: unknown) => unknown;
    };
    const db = labeledDb();
    await seed(
      db,
      "INSERT INTO emails (subject) VALUES (?), (?)",
      ["Recovered, a service is not active", "Your weekly digest"],
    );

    const summarizer = lift(summarize);
    const p = cf.pattern(() => {
      const query = cf.sqliteQuery.asScope("session")(
        // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
        { db, reactOn: db, sql: SELECT_ROWS } as any,
      );
      return { query, summary: summarizer(query) };
    });

    const tx = runtime!.edit();
    const resultCell = runtime!.getCell(space, cause, p.resultSchema, tx);
    const result = runtime!.run(tx, p, {}, resultCell);
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    await waitForCellValue<QueryState>(
      runtime!,
      // deno-lint-ignore no-explicit-any -- the query's state, as the builtin writes it
      (result.key("query") as any),
      (state) => state?.pending === false,
    );
    await result.pull();
    await runtime!.idle();

    // Read back through a fresh write, the way the pointwise suite does: what
    // a consumer of the value derives is the question, and which internal
    // document the content landed in is not.
    const ptx = runtime!.edit();
    // deno-lint-ignore no-explicit-any -- the summary's shape is the lift's
    const summary = (result.key("summary") as any).withTx(ptx).get();
    const out = runtime!.getCell(space, `${cause}-probe`, undefined, ptx);
    out.set({ copied: summary } as FabricValue);
    ptx.prepareCfc();
    expect((await ptx.commit()).ok).toBeDefined();
    return {
      confidentiality: derivedConfidentiality(
        out.getAsNormalizedFullLink().id,
      ),
      summary,
    };
  };

  const startRuntime = (): void => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
  };

  it("carries the rows' class into a value a predicate over their fields decided", async () => {
    // Arm A. Every row's labeled field is read and none survives the
    // predicate, which is what a bill classifier that matched nothing does.
    // The rows decided the count, so their class belongs on it.
    startRuntime();

    const { confidentiality, summary } = await summaryConfidentiality(
      "query-rows-arm-a",
      (query) => {
        const rows = query?.result ?? [];
        const kept = rows.filter((row) =>
          String(row?.subject ?? "").includes("invoice")
        );
        return { count: rows.length, kept: kept.length };
      },
    );

    // The predicate has to have read the rows for the label question to mean
    // anything: a fixture whose links never resolve keeps `subject` undefined
    // and reaches no row document at all.
    expect(summary).toEqual({ count: 2, kept: 0 });
    expect(confidentiality).toContainEqual(ROW_CLASS);
  });

  it("carries no class into a value read off the row count alone", async () => {
    // Arm B. The container's own entries carry no confidentiality, so a
    // computation that never opens a row has nothing to pick up — and how
    // many rows there are is not a fact about any one of them.
    startRuntime();

    const { confidentiality, summary } = await summaryConfidentiality(
      "query-rows-arm-b",
      (query) => ({ count: (query?.result ?? []).length }),
    );

    expect(summary).toEqual({ count: 2 });
    expect(confidentiality).not.toContainEqual(ROW_CLASS);
  });
});
