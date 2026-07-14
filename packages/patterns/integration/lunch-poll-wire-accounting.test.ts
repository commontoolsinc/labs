import { assert, assertEquals } from "@std/assert";
import type {
  MemoryWireAccountingRecord,
  MemoryWireAccountingReport,
} from "@commonfabric/memory/v2/wire-accounting";
import {
  analyzeLunchPollWireAccounting,
  formatLunchPollWireAccounting,
  validateLunchPollWireAccounting,
} from "./lunch-poll-wire-accounting.ts";

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
): MemoryWireAccountingRecord => ({
  direction: "outbound",
  connectionId: "browser-a",
  metadata: { kind: "browser" },
  classification: "server.session/effect.sync",
  baselineBytes: 100,
  actualBytes: 50,
  ...overrides,
});

Deno.test("analyzeLunchPollWireAccounting handles no browser records", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport());

  assertEquals(analysis.records, []);
  assertEquals(analysis.rows, []);
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

Deno.test("validateLunchPollWireAccounting accepts browser sync savings invariants", () => {
  const analysis = analyzeLunchPollWireAccounting(emptyReport([
    record({
      direction: "inbound",
      connectionId: "browser-a",
      classification: "client.watch",
      baselineBytes: 100,
      actualBytes: 100,
    }),
    record({
      direction: "inbound",
      connectionId: "browser-b",
      classification: "client.watch",
      baselineBytes: 80,
      actualBytes: 80,
    }),
    record({
      direction: "outbound",
      connectionId: "browser-a",
      classification: "server.hello.ok",
      baselineBytes: 20,
      actualBytes: 20,
    }),
    record({
      direction: "outbound",
      connectionId: "browser-a",
      classification: "server.session/effect.sync",
      baselineBytes: 1_000,
      actualBytes: 400,
    }),
    record({
      direction: "outbound",
      connectionId: "browser-b",
      classification: "server.response.watch.sync",
      baselineBytes: 500,
      actualBytes: 250,
    }),
  ]));

  assertEquals(validateLunchPollWireAccounting(analysis), []);
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

  assert(errors.some((error) => error.includes("at least two distinct")));
  assert(errors.some((error) => error.includes("inbound client.watch")));
  assert(
    errors.some((error) => error.includes("outbound non-sync server.hello.ok")),
  );
  assert(errors.some((error) => error.includes("at least 15.0% savings")));
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
    ].join("\n"),
  );
});
