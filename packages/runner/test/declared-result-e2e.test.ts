// A CTS-authored `action<Event, Result>` verb, compiled through the real
// pipeline (`patternManager.compilePattern` → js-compiler → CTS transformers →
// SES evaluation), delivers its returned value into the event receipt under
// the `plainResultReceipts` experimental flag — the composition of this
// package's plain-return projection (scheduler-event-receipts.test.ts, which
// exercises only the raw trusted-builder `handler`) with the api's declared-
// result authoring surface. This is the readback half of WS-C's exit
// criterion, pinned at the runner in addition to the end-to-end fixture
// (pattern-verb-contract-implementation.md, D4).
//
// The incidental-cell-return case pins the receipt write's conversion: `set()`
// returns its cell for chaining, so an expression-body
// `action(() => cell.set(...))` returns a live Cell. The receipt write goes
// through the cell's standard write flow, so that return is recorded as a LINK
// to the mutated cell — receipts reflect what was returned (a raw write fails
// the whole handling on the live object instead).
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
} from "./scheduler-test-utils.ts";
import type {
  Cell,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { resolveLink } from "../src/link-resolution.ts";

// One verb declared with `action<Event, Result>` whose body returns a value
// derived from the event (provably from that dispatch), and one value-less
// verb beside it. `count` is exposed so the tests can observe in value
// position that both compiled handler bodies actually ran.
const DECLARED_RESULT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, cell, pattern, Stream } from "commonfabric";',
      "",
      "interface AddTopic {",
      "  title: string;",
      "}",
      "",
      "interface AddTopicResult {",
      "  topic: { fid: string };",
      "}",
      "",
      "interface Verbs {",
      "  addTopic: Stream<AddTopic, AddTopicResult>;",
      "  touch: Stream<AddTopic>;",
      "  bump: Stream<AddTopic>;",
      "  count: number;",
      "}",
      "",
      "export default pattern<Record<string, never>, Verbs>(() => {",
      "  const count = cell(0);",
      "",
      "  const addTopic = action<AddTopic, AddTopicResult>((event) => {",
      "    count.set(count.get() + 1);",
      "    return { topic: { fid: event.title } };",
      "  });",
      "",
      "  const touch = action((_event: AddTopic) => {",
      "    count.set(count.get() + 1);",
      "  });",
      "",
      "  // Expression body: implicitly returns `count.set(...)`'s chained",
      "  // cell — the incidental cell return the standard receipt write",
      "  // conversion records as a link to the mutated cell.",
      "  const bump = action((_event: AddTopic) => count.set(count.get() + 1));",
      "",
      "  return { addTopic, touch, bump, count };",
      "});",
    ].join("\n"),
  }],
};

// Same shape as scheduler-event-receipts.test.ts's file-local helper.
async function waitForSchedulerCondition(
  runtime: Runtime,
  condition: () => boolean,
  message: string,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!condition() && performance.now() < deadline) {
    await runtime.idle();
  }
  if (!condition()) {
    throw new Error(message);
  }
}

// NOTE on receipt addressing: the receipt cause is `{ ...inputs, $event }`
// (`instantiateJavaScriptHandlerNode`, `src/runner.ts`), so a handler with
// bound context — every compiled CTS verb, whose closed-over cells lower to
// `$ctx` bindings — does NOT live at the `{ resultFor: { $ctx: {}, $event } }`
// address the trusted-builder tests use. The route a real caller takes, and
// the one these tests take, is `cell.send` with a caller event id, then
// reading `tx.handlingReceiptLink` from the commit callback (WS-D; production
// consumer: `packages/cli/lib/callable.ts`).
type ReceiptLink = NonNullable<
  IExtendedStorageTransaction["handlingReceiptLink"]
>;

type Outcome = { status: string; receiptLink?: ReceiptLink };

describe("compiled CTS action<E, R> results in receipts", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { experimental: { plainResultReceipts: true } },
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  async function instantiate(rootName: string) {
    const compiled = await runtime.patternManager.compilePattern(
      DECLARED_RESULT_PROGRAM,
      { space, tx },
    );
    const rootCell = runtime.getCell<{
      addTopic: unknown;
      touch: unknown;
      bump: unknown;
      count: number;
    }>(
      space,
      rootName,
      undefined,
      tx,
    );
    const root = runtime.run(tx, compiled, {}, rootCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    await root.pull();
    return root;
  }

  function dispatch(
    stream: Cell<unknown>,
    payload: unknown,
    eventId: string,
    outcomes: Outcome[],
  ) {
    stream.send(payload, (t: IExtendedStorageTransaction) => {
      outcomes.push({
        status: t.status().status,
        receiptLink: t.handlingReceiptLink,
      });
    }, { eventId });
  }

  it("projects the declared result into the receipt; value-less verb stays {}", async () => {
    const root = await instantiate("declared result e2e root");
    const outcomes: Outcome[] = [];

    dispatch(
      root.key("addTopic") as Cell<unknown>,
      { title: "verb-result-proof" },
      "evt:declared-result:0:add-topic",
      outcomes,
    );
    await waitForSchedulerCondition(
      runtime,
      () => outcomes.length === 1,
      "declared-result verb event did not settle",
    );

    dispatch(
      root.key("touch") as Cell<unknown>,
      { title: "no-result" },
      "evt:declared-result:1:touch",
      outcomes,
    );
    await waitForSchedulerCondition(
      runtime,
      () => outcomes.length === 2,
      "value-less verb event did not settle",
    );
    await runtime.scheduler.idleWithPendingCommits();

    // Both handlings committed and handed back their receipt address.
    expect(outcomes[0].status).toBe("done");
    expect(outcomes[1].status).toBe("done");
    expect(outcomes[0].receiptLink).toBeDefined();
    expect(outcomes[1].receiptLink).toBeDefined();

    // Both compiled handler bodies executed.
    const count = await root.key("count").pull();
    expect(count).toBe(2);

    // The declared-result verb: its returned value, derived from THIS
    // dispatch's payload, read back at the receipt address the transaction
    // handed to the caller.
    const addTopicReceipt = runtime.getCellFromLink<Record<string, unknown>>(
      outcomes[0].receiptLink!,
    );
    expect(await addTopicReceipt.pull()).toEqual({
      topic: { fid: "verb-result-proof" },
    });

    // The value-less verb beside it keeps the empty witness.
    const touchReceipt = runtime.getCellFromLink<Record<string, never>>(
      outcomes[1].receiptLink!,
    );
    expect(await touchReceipt.pull()).toEqual({});

    // The two receipts are distinct documents.
    expect(outcomes[0].receiptLink!.id).not.toBe(outcomes[1].receiptLink!.id);
  });

  it("projects an incidental cell return (chained set) as a link to the mutated cell", async () => {
    const root = await instantiate("incidental cell return root");
    const outcomes: Outcome[] = [];

    dispatch(
      root.key("bump") as Cell<unknown>,
      { title: "incidental" },
      "evt:declared-result:3:bump",
      outcomes,
    );
    await waitForSchedulerCondition(
      runtime,
      () => outcomes.length === 1,
      "incidental-cell-return event did not settle",
    );
    await runtime.scheduler.idleWithPendingCommits();

    // The handling commits — the chained cell return must not fail the
    // action ("Cannot clone: CellImpl", the raw-write bug) — and the body
    // ran.
    expect(outcomes[0].status).toBe("done");
    expect(await root.key("count").pull()).toBe(1);

    // The receipt went through the standard cell-write conversion, so it
    // carries a LINK to the returned cell. Assert by identity, not shape:
    // resolve both the stored link and the pattern's own `count` cell
    // through the same link machinery and compare addresses.
    const receipt = runtime.getCellFromLink<unknown>(
      outcomes[0].receiptLink!,
    );
    await receipt.pull();
    const written = parseLink(receipt.getRaw(), receipt);
    expect(written).toBeDefined();
    const writtenResolved = resolveLink(runtime, runtime.readTx(), written!);
    const target = resolveLink(
      runtime,
      runtime.readTx(),
      (root.key("count") as Cell<number>).getAsNormalizedFullLink(),
    );
    expect(writtenResolved.space).toBe(target.space);
    expect(writtenResolved.id).toBe(target.id);
    expect(writtenResolved.path).toEqual(target.path);
  });

  it("discards the declared result while plainResultReceipts is off (default)", async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
    const root = await instantiate("declared result e2e flag-off root");
    const outcomes: Outcome[] = [];

    dispatch(
      root.key("addTopic") as Cell<unknown>,
      { title: "verb-result-proof" },
      "evt:declared-result:2:flag-off",
      outcomes,
    );
    await waitForSchedulerCondition(
      runtime,
      () => outcomes.length === 1,
      "flag-off event did not settle",
    );
    await runtime.scheduler.idleWithPendingCommits();

    // The body ran and returned a value, but the projection is flag-gated:
    // the receipt keeps the empty witness.
    expect(outcomes[0].status).toBe("done");
    const receipt = runtime.getCellFromLink<Record<string, unknown>>(
      outcomes[0].receiptLink!,
    );
    expect(await receipt.pull()).toEqual({});
  });
});
