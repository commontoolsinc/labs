import { assert, assertEquals } from "@std/assert";
import type {
  MemoryWireAccountingRecord,
  MemoryWireAccountingReport,
} from "@commonfabric/memory/v2/wire-accounting";
import {
  analyzeLunchPollWireAccounting,
  formatLunchPollWireAccounting,
  isMemoryWireAccountingReport,
  validateLunchPollWireAccounting,
} from "./lunch-poll-wire-accounting.ts";

const semanticBytes = (bytes: number) => ({
  encoding: bytes,
  identity: 0,
  sequence: 0,
  sessionControl: 0,
  authCapability: 0,
  schema: 0,
  documentValue: 0,
  patchOperation: 0,
  queryWatch: 0,
  sqliteScheduler: 0,
  error: 0,
  uncategorized: 0,
});

const emptyReport = (
  records: MemoryWireAccountingRecord[] = [],
): MemoryWireAccountingReport => ({
  totals: { baselineBytes: 0, actualBytes: 0, frames: 0, connections: 0 },
  byDirection: [],
  byConnection: [],
  byMetadataKind: [],
  byClassification: [],
  records,
});

const record = (
  overrides: Partial<MemoryWireAccountingRecord>,
): MemoryWireAccountingRecord => {
  const value = {
    direction: "outbound" as const,
    connectionId: "browser-a",
    metadata: { kind: "browser" },
    classification: "server.session/effect.sync",
    baselineBytes: 100,
    actualBytes: 50,
    ...overrides,
  };
  return {
    ...value,
    baselineSemanticBytes: overrides.baselineSemanticBytes ??
      semanticBytes(value.baselineBytes),
    actualSemanticBytes: overrides.actualSemanticBytes ??
      semanticBytes(value.actualBytes),
  };
};

const validRecords = (
  requestSchemaCasEnabled = true,
): MemoryWireAccountingRecord[] => [
  record({
    direction: "inbound",
    connectionId: "browser-a",
    classification: "client.graph.query",
    baselineBytes: 100,
    actualBytes: requestSchemaCasEnabled ? 80 : 100,
  }),
  record({
    direction: "inbound",
    connectionId: "browser-b",
    classification: "client.session.watch.add",
    baselineBytes: 100,
    actualBytes: requestSchemaCasEnabled ? 80 : 100,
  }),
  record({
    direction: "inbound",
    connectionId: "browser-c",
    classification: "client.transact",
    baselineBytes: 180,
    actualBytes: requestSchemaCasEnabled ? 120 : 180,
  }),
  record({
    connectionId: "browser-d",
    classification: "server.hello.ok",
    baselineBytes: 20,
    actualBytes: 20,
  }),
  record({
    connectionId: "browser-e",
    baselineBytes: 1_000,
    actualBytes: 400,
  }),
  record({
    connectionId: "browser-f",
    classification: "server.response.watch.sync",
    baselineBytes: 500,
    actualBytes: 250,
  }),
];

Deno.test("analyzeLunchPollWireAccounting handles no browser records", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport());

  assertEquals(analysis.records, []);
  assertEquals(analysis.rows, []);
  assertEquals(analysis.protocolSemanticRows, []);
  assertEquals(analysis.candidateRows, []);
  assertEquals(analysis.totals, {
    baselineBytes: 0,
    actualBytes: 0,
    frames: 0,
    connections: 0,
    savedBytes: 0,
    savedPercent: 0,
  });
  assert(
    validateLunchPollWireAccounting(analysis).includes(
      "expected at least one browser Memory websocket frame",
    ),
  );
});

Deno.test("analyzeLunchPollWireAccounting filters browser records from runtime records", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport([
    record({ connectionId: "browser-a", baselineBytes: 120, actualBytes: 60 }),
    record({
      connectionId: "runtime-a",
      metadata: { kind: "runtime" },
      baselineBytes: 10_000,
      actualBytes: 1,
    }),
  ]));

  assertEquals(analysis.records.length, 1);
  assertEquals(analysis.totals.baselineBytes, 120);
  assertEquals(analysis.totals.actualBytes, 60);
  assertEquals(analysis.totals.connections, 1);
});

Deno.test("analyzeLunchPollWireAccounting produces deterministic classification rows and safe zero percentages", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport([
    record({
      direction: "outbound",
      classification: "server.response.watch.sync",
      connectionId: "browser-b",
      baselineBytes: 0,
      actualBytes: 0,
    }),
    record({
      direction: "inbound",
      classification: "client.watch",
      connectionId: "browser-a",
      baselineBytes: 5,
      actualBytes: 5,
    }),
    record({
      direction: "outbound",
      classification: "server.hello.ok",
      connectionId: "browser-a",
      baselineBytes: 10,
      actualBytes: 10,
    }),
  ]));

  assertEquals(
    analysis.rows.map((row) => `${row.classification}:${row.direction}`),
    [
      "client.watch:inbound",
      "server.hello.ok:outbound",
      "server.response.watch.sync:outbound",
    ],
  );
  assertEquals(analysis.rows[2].savedPercent, 0);
});

Deno.test("analyzeLunchPollWireAccounting cross-tabs protocol classes and semantic bytes", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport([
    record({
      direction: "outbound",
      classification: "server.hello.ok",
      actualBytes: 10,
      actualSemanticBytes: {
        encoding: 4,
        identity: 6,
        sequence: 0,
        sessionControl: 0,
        authCapability: 0,
        schema: 0,
        documentValue: 0,
        patchOperation: 0,
        queryWatch: 0,
        sqliteScheduler: 0,
        error: 0,
        uncategorized: 0,
      },
    }),
    record({
      direction: "inbound",
      classification: "client.watch",
      actualBytes: 5,
      actualSemanticBytes: {
        encoding: 0,
        identity: 0,
        sequence: 5,
        sessionControl: 0,
        authCapability: 0,
        schema: 0,
        documentValue: 0,
        patchOperation: 0,
        queryWatch: 0,
        sqliteScheduler: 0,
        error: 0,
        uncategorized: 0,
      },
    }),
  ]));
  assertEquals(
    analysis.protocolSemanticRows.map((row) =>
      `${row.classification}:${row.direction}:${row.category}`
    ),
    [
      "client.watch:inbound:sequence",
      "server.hello.ok:outbound:encoding",
      "server.hello.ok:outbound:identity",
    ],
  );
  assertEquals(analysis.protocolSemanticRows[1].percentOfProtocolClass, 40);
  assertEquals(analysis.protocolSemanticRows[2].percentOfAllTraffic, 40);
  assertEquals(
    analysis.protocolSemanticRows.reduce(
      (sum, row) => sum + row.actualBytes,
      0,
    ),
    analysis.totals.actualBytes,
  );
});

Deno.test("validateLunchPollWireAccounting accepts browser sync savings invariants", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport(validRecords()));

  assertEquals(validateLunchPollWireAccounting(analysis), []);
});

Deno.test("validateLunchPollWireAccounting accepts inline request schemas when CAS is disabled", () => {
  const analysis = analyzeLunchPollWireAccounting(
    emptyReport(validRecords(false)),
  );

  assertEquals(
    validateLunchPollWireAccounting(analysis, {
      requestSchemaCasEnabled: false,
    }),
    [],
  );
});

Deno.test("validateLunchPollWireAccounting reports invariant failures", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport([
    record({
      direction: "inbound",
      connectionId: "browser-a",
      classification: "client.watch",
      baselineBytes: 100,
      actualBytes: 90,
    }),
    record({
      direction: "outbound",
      connectionId: "browser-a",
      classification: "server.hello.ok",
      baselineBytes: 20,
      actualBytes: 10,
    }),
    record({
      direction: "outbound",
      connectionId: "browser-a",
      classification: "server.session/effect.sync",
      baselineBytes: 100,
      actualBytes: 90,
    }),
  ]));
  const errors = validateLunchPollWireAccounting(analysis);

  assert(errors.some((error) => error.includes("expected 6 distinct")));
  assert(errors.some((error) => error.includes("inbound client.watch")));
  assert(
    errors.some((error) => error.includes("outbound non-sync server.hello.ok")),
  );
  assert(errors.some((error) => error.includes("at least 15.0% savings")));
});

Deno.test("isMemoryWireAccountingReport rejects malformed record evidence", () => {
  const malformed = {
    ...emptyReport(),
    records: [{
      direction: "inbound",
      connectionId: "browser-a",
      classification: "client.graph.query",
      baselineBytes: Number.NaN,
      actualBytes: 10,
      baselineSemanticBytes: semanticBytes(10),
      actualSemanticBytes: semanticBytes(10),
    }],
  };

  assert(!isMemoryWireAccountingReport(malformed));
  assert(
    !isMemoryWireAccountingReport({
      ...emptyReport(),
      records: [{
        ...malformed.records[0],
        baselineBytes: 10.5,
      }],
    }),
  );
  assert(
    !isMemoryWireAccountingReport({
      ...emptyReport(),
      records: [{
        direction: "inbound",
        connectionId: "browser-a",
        classification: "client.graph.query",
        baselineBytes: 10,
        actualBytes: 10,
        baselineSemanticBytes: semanticBytes(10),
      }],
    }),
  );
});

Deno.test("validateLunchPollWireAccounting requires the stable request classes", () => {
  const records = validRecords();
  records[0] = record({
    ...records[0],
    classification: "client.session.watch.set",
  });
  const errors = validateLunchPollWireAccounting(
    analyzeLunchPollWireAccounting(emptyReport(records)),
  );

  assert(
    errors.some((error) => error.includes("client.graph.query")),
  );
});

Deno.test("validateLunchPollWireAccounting conserves baseline semantic bytes", () => {
  const records = validRecords();
  records[0] = record({
    ...records[0],
    baselineSemanticBytes: semanticBytes(99),
  });
  const errors = validateLunchPollWireAccounting(
    analyzeLunchPollWireAccounting(emptyReport(records)),
  );

  assert(
    errors.some((error) => error.includes("baseline semantic bytes differ")),
  );
});

Deno.test("validateLunchPollWireAccounting enforces request-CAS and overall savings floors", () => {
  const requestSavingsRecords = validRecords().map((item) => {
    if (item.direction !== "inbound") return item;
    const actualBytes = item.baselineBytes - 5;
    return record({
      ...item,
      actualBytes,
      actualSemanticBytes: semanticBytes(actualBytes),
    });
  });
  const requestSavingsErrors = validateLunchPollWireAccounting(
    analyzeLunchPollWireAccounting(emptyReport(requestSavingsRecords)),
  );
  assert(
    requestSavingsErrors.some((error) =>
      error.includes("request-schema-CAS inbound")
    ),
  );

  const overallSavingsRecords = [
    ...validRecords(),
    record({
      direction: "inbound",
      connectionId: "browser-a",
      classification: "client.session.watch.set",
      baselineBytes: 10_000,
      actualBytes: 10_000,
    }),
  ];
  const overallSavingsErrors = validateLunchPollWireAccounting(
    analyzeLunchPollWireAccounting(emptyReport(overallSavingsRecords)),
  );
  assert(
    overallSavingsErrors.some((error) =>
      error.includes("overall browser-byte")
    ),
  );
});

Deno.test("formatLunchPollWireAccounting prints the headline and per-class table", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport([
    record({
      direction: "inbound",
      connectionId: "browser-a",
      classification: "client.watch",
      baselineBytes: 10,
      actualBytes: 10,
    }),
    record({
      direction: "outbound",
      connectionId: "browser-a",
      classification: "server.session/effect.sync",
      baselineBytes: 100,
      actualBytes: 40,
    }),
    record({
      direction: "outbound",
      connectionId: "browser-b",
      classification: "server.session/effect.sync",
      baselineBytes: 50,
      actualBytes: 30,
    }),
  ]));

  assertEquals(
    formatLunchPollWireAccounting(analysis),
    [
      "baseline 160 bytes over 2 browser connections; actual 80 bytes over 2 browser connections; saved 80 bytes (50.0%)",
      "direction | classification | frames | baseline bytes | actual bytes | saved bytes | saved %",
      "inbound | client.watch | 1 | 10 | 10 | 0 | 0.0%",
      "outbound | server.session/effect.sync | 2 | 150 | 70 | 80 | 53.3%",
      "direction | classification | category | actual bytes | % of protocol class | % of all traffic",
      "inbound | client.watch | encoding | 10 | 100.0% | 12.5%",
      "outbound | server.session/effect.sync | encoding | 70 | 100.0% | 87.5%",
      "category | scope | candidate bytes | candidates | repeats (connection) | repeat bytes (connection) | reference cost (connection) | net savings (connection)",
    ].join("\n"),
  );
});

Deno.test("analyzeLunchPollWireAccounting reports scoped repeat opportunities and reference cost", () => {
  const candidate = {
    category: "schema" as const,
    scope: "immutableInternable" as const,
    fingerprint: "run-local-a",
    encodedBytes: 100,
  };
  const analysis = analyzeLunchPollWireAccounting(emptyReport([
    record({
      connectionId: "browser-a",
      actualBytes: 100,
      actualSemanticBytes: {
        encoding: 0,
        identity: 0,
        sequence: 0,
        sessionControl: 0,
        authCapability: 0,
        schema: 100,
        documentValue: 0,
        patchOperation: 0,
        queryWatch: 0,
        sqliteScheduler: 0,
        error: 0,
        uncategorized: 0,
      },
      actualCandidates: [candidate],
    }),
    record({
      connectionId: "browser-a",
      actualBytes: 100,
      actualSemanticBytes: {
        encoding: 0,
        identity: 0,
        sequence: 0,
        sessionControl: 0,
        authCapability: 0,
        schema: 100,
        documentValue: 0,
        patchOperation: 0,
        queryWatch: 0,
        sqliteScheduler: 0,
        error: 0,
        uncategorized: 0,
      },
      actualCandidates: [candidate],
    }),
    record({
      connectionId: "browser-b",
      actualBytes: 100,
      actualSemanticBytes: {
        encoding: 0,
        identity: 0,
        sequence: 0,
        sessionControl: 0,
        authCapability: 0,
        schema: 100,
        documentValue: 0,
        patchOperation: 0,
        queryWatch: 0,
        sqliteScheduler: 0,
        error: 0,
        uncategorized: 0,
      },
      actualCandidates: [candidate],
    }),
  ]));
  const schema = analysis.candidateRows.find((row) =>
    row.category === "schema"
  );
  assertEquals(schema?.candidateBytes, 300);
  assertEquals(schema?.candidateOccurrences, 3);
  assertEquals(schema?.repeatOccurrencesConnectionLocal, 1);
  assertEquals(schema?.repeatBytesConnectionLocal, 100);
  assertEquals(schema?.referenceCostConnectionLocal, 12);
  assertEquals(schema?.netSavingsConnectionLocal, 88);
});

Deno.test("analyzeLunchPollWireAccounting allocates semantic bytes to candidate scopes", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport([
    record({
      actualBytes: 150,
      actualSemanticBytes: {
        encoding: 0,
        identity: 0,
        sequence: 0,
        sessionControl: 0,
        authCapability: 0,
        schema: 150,
        documentValue: 0,
        patchOperation: 0,
        queryWatch: 0,
        sqliteScheduler: 0,
        error: 0,
        uncategorized: 0,
      },
      actualCandidates: [
        {
          category: "schema",
          scope: "immutableInternable",
          fingerprint: "a",
          encodedBytes: 100,
        },
        {
          category: "schema",
          scope: "alreadyContentAddressed",
          fingerprint: "b",
          encodedBytes: 30,
        },
      ],
    }),
  ]));
  const immutable = analysis.candidateRows.find((row) =>
    row.category === "schema" && row.scope === "immutableInternable"
  );
  const addressed = analysis.candidateRows.find((row) =>
    row.category === "schema" && row.scope === "alreadyContentAddressed"
  );
  assertEquals(immutable?.candidateBytes, 100);
  assertEquals(addressed?.candidateBytes, 30);
  assertEquals(
    analysis.candidateRows.reduce((sum, row) => sum + row.candidateBytes, 0),
    130,
  );
});

Deno.test("validateLunchPollWireAccounting rejects truncated and inconsistent accounting", () => {
  const analysis = analyzeLunchPollWireAccounting({
    ...emptyReport([record({
      actualBytes: 10,
      actualSemanticBytes: {
        encoding: 9,
        identity: 0,
        sequence: 0,
        sessionControl: 0,
        authCapability: 0,
        schema: 0,
        documentValue: 0,
        patchOperation: 0,
        queryWatch: 0,
        sqliteScheduler: 0,
        error: 0,
        uncategorized: 0,
      },
      actualCandidates: [{
        category: "encoding",
        scope: "contextualControl",
        fingerprint: "x",
        encodedBytes: 11,
      }],
    })]),
    truncated: { reason: "limit" },
  });
  const errors = validateLunchPollWireAccounting(analysis);
  assert(errors.some((error) => error.includes("truncated")));
  assert(errors.some((error) => error.includes("semantic bytes differ")));
  assert(errors.some((error) => error.includes("candidate bytes exceed")));
});
