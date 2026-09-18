/**
 * The `agent` builtin without a runner: what its staging transaction leaves
 * behind, and how its result cell follows the record from there.
 *
 * No agent runs here. The record the post-commit effect creates is the
 * handoff to a runner, so a fake runner in each case writes the fields a
 * real one would — `claimed`, `completed` with a result link, `failed` with
 * an error code — straight into the record, and the cases assert what the
 * builtin's result cell derives from each.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { createBuilder } from "../src/builder/factory.ts";
import { agentQueueIndexCell } from "../src/builtins/agent.ts";
import type { Cell } from "../src/cell.ts";
import { isCellLink } from "../src/link-utils.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("agent builtin");
const space = signer.did();

const RESULT_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const;

// A caveat no sink is cleared for under an empty ceiling. Reading an input
// carrying it puts it on the staged request, which the `agent: []` ceiling
// below refuses at `enforce-strict`.
const PROMPT_INFLUENCE = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

type AgentResult = {
  pending?: boolean;
  result?: { answer: string };
  error?: string;
  requestHash?: string;
  run?: { state?: string; submittedAt?: string; tools?: string[] };
  host?: string;
};

describe("agent builtin", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: ReturnType<typeof createBuilder>["commonfabric"];

  /** Builds the runtime under test; `agentBuiltin` is on unless overridden. */
  const setUp = (options: Partial<RuntimeOptions> = {}) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager,
      experimental: { agentBuiltin: true },
      ...options,
    });
    tx = runtime.edit();
    ({ commonfabric } = createTrustedBuilder(runtime));
  };

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  /** Runs a pattern calling `agent()` over `finished`, and returns its cell. */
  const runAgentPattern = (
    id: string,
    params: Record<string, unknown> = {},
  ): Cell<AgentResult> => {
    const { pattern, agent, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const finished = BuilderCell.of(["Dune", "Solaris"], {
        type: "array",
        items: { type: "string" },
      });
      return agent({
        task: "which of these would a reader of the listed authors like?",
        inputs: { finished },
        resultSchema: RESULT_SCHEMA,
        ...params,
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    const resultCell = runtime.getCell(space, id, testPattern.resultSchema, tx);
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    return result as Cell<AgentResult>;
  };

  /** Resolves once the record behind `result.run` reports a state. */
  const waitForRecord = async (result: Cell<AgentResult>) => {
    await waitForCellValue<{ state?: string }>(
      runtime,
      result.key("run"),
      (value) => value?.state !== undefined,
    );
    await runtime.settled();
    return result.key("run").resolveAsCell();
  };

  it("settles with an error naming the flag when `agentBuiltin` is off", async () => {
    setUp({ experimental: {} });
    const result = runAgentPattern("agent-flag-off");
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => typeof value?.error === "string",
    );
    await runtime.settled();

    expect(settled.error).toContain("agentBuiltin");
    expect(settled.pending).toBe(false);
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  it("creates a queued record holding the task as a value and each input as a link", async () => {
    setUp();
    const result = runAgentPattern("agent-record-shape");
    await tx.commit();

    const record = await waitForRecord(result);
    const raw = record.getRaw() as Record<string, unknown>;

    expect(raw.state).toBe("queued");
    expect(raw.task).toBe(
      "which of these would a reader of the listed authors like?",
    );
    expect(typeof raw.submittedAt).toBe("string");
    expect(raw.stateSince).toBe(raw.submittedAt);
    expect(raw.requestHash).toBe(result.withTx().key("requestHash").get());
    // The input reaches the record as a reference and never as its value.
    const inputs = raw.inputs as Record<string, unknown>;
    expect(isCellLink(inputs.finished)).toBe(true);
    expect(record.key("inputs").key("finished").get()).toEqual([
      "Dune",
      "Solaris",
    ]);
    expect(result.withTx().key("pending").get()).toBe(true);
    // The host serving the record's space rides beside the `run` link.
    expect(result.withTx().key("host").get()).toBe("https://fabric.example");
    // Nothing a runner writes is present yet.
    expect(raw.claim).toBeUndefined();
    expect(raw.result).toBeUndefined();
    expect(raw.outcome).toBeUndefined();
  });

  it("appends one `{run, host}` entry to the requester's home index", async () => {
    setUp();
    const result = runAgentPattern("agent-home-index");
    await tx.commit();

    const record = await waitForRecord(result);
    const index = agentQueueIndexCell(runtime, space);
    const entries = await waitForCellValue<{ run: unknown; host: string }[]>(
      runtime,
      index.key("entries"),
      (value) => (value?.length ?? 0) > 0,
    );

    expect(entries.length).toBe(1);
    expect(entries[0].host).toBe("https://fabric.example");
    expect(
      index.key("entries").key(0).key("run").resolveAsCell()
        .getAsNormalizedFullLink().id,
    ).toBe(record.getAsNormalizedFullLink().id);
  });

  it("creates no second record on a memo hit", async () => {
    setUp();
    const hits: string[] = [];
    runtime.effectMemoObserver = (event) => {
      if (event.kind === "hit") hits.push(event.id);
    };
    const result = runAgentPattern("agent-memo-hit");
    await tx.commit();

    const record = await waitForRecord(result);
    const submittedAt = record.get()?.submittedAt;
    const hash = result.withTx().key("requestHash").get();

    // A runner's claim changes the record, which re-runs the builtin over an
    // unchanged request: the memo hit, and no second staging.
    await runtime.editWithRetry((tx) => {
      record.withTx(tx).key("state").set("claimed");
      record.withTx(tx).key("stateSince").set("2026-09-18T00:00:01.000Z");
    });
    await waitForCellValue<{ state?: string }>(
      runtime,
      result.key("run"),
      (value) => value?.state === "claimed",
    );
    await runtime.settled();

    expect(hits).toContain(`agent:${hash}`);
    expect(record.get()?.submittedAt).toBe(submittedAt);
    expect(result.withTx().key("pending").get()).toBe(true);
    const entries = agentQueueIndexCell(runtime, space).key("entries").get();
    expect(entries?.length).toBe(1);
  });

  it("derives `pending: false` and `result` from a completed record", async () => {
    setUp();
    const result = runAgentPattern("agent-completed");
    await tx.commit();

    const record = await waitForRecord(result);
    const answer = runtime.getCell<{ answer: string }>(
      space,
      "agent-completed-answer",
      RESULT_SCHEMA,
    );
    await runtime.editWithRetry((tx) => {
      answer.withTx(tx).set({ answer: "Solaris" });
      const recordTx = record.withTx(tx);
      recordTx.key("state").set("completed");
      recordTx.key("outcome").set("completed");
      recordTx.key("result").set(answer);
    });

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.error).toBeUndefined();
    expect(result.withTx().key("result").get()).toEqual({ answer: "Solaris" });
    expect(result.withTx().key("run").get()?.state).toBe("completed");
  });

  it("derives `error` from a failed record's `errorCode`", async () => {
    setUp();
    const result = runAgentPattern("agent-failed");
    await tx.commit();

    const record = await waitForRecord(result);
    await runtime.editWithRetry((tx) => {
      const recordTx = record.withTx(tx);
      recordTx.key("state").set("failed");
      recordTx.key("outcome").set("failed");
      recordTx.key("errorCode").set("PROVIDER_FAILURE");
    });

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.error).toBe("PROVIDER_FAILURE");
    expect(result.withTx().key("result").get()).toBeUndefined();
  });

  it("settles the refusal when the staging transaction is abandoned", async () => {
    setUp({
      cfcEnforcementMode: "enforce-strict",
      cfcSinkMaxConfidentiality: { agent: [] },
    });
    const { Cell: BuilderCell } = commonfabric;
    const { pattern, agent } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const task = BuilderCell.of("a briefing the ceiling does not admit", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      // deno-lint-ignore no-explicit-any
      return agent({ task, inputs: {}, resultSchema: RESULT_SCHEMA } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "agent-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell) as Cell<
      AgentResult
    >;
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => typeof value?.error === "string" && value.error.length > 0,
    );
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(settled.pending).toBe(false);
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  it("refuses before staging a request outside its own `maxConfidentiality`", async () => {
    setUp();
    const { pattern, agent, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const task = BuilderCell.of("a task built from labeled data", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      return agent({
        task,
        inputs: {},
        resultSchema: RESULT_SCHEMA,
        maxConfidentiality: [],
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "agent-own-ceiling",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell) as Cell<
      AgentResult
    >;
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => typeof value?.error === "string" && value.error.length > 0,
    );
    await runtime.settled();

    expect(settled.error).toContain("maxConfidentiality");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(settled.pending).toBe(false);
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  describe("the tool check against the registered runner", () => {
    it("fails before staging when `tools` names a tool the runner does not offer", async () => {
      setUp();
      await runtime.editWithRetry((tx) => {
        agentQueueIndexCell(runtime, space, tx).key("agentRunner").set({
          host: "https://fabric.example",
          tools: ["loom_search"],
          registeredAt: "2026-09-18T00:00:00.000Z",
        });
      });
      const result = runAgentPattern("agent-tool-refused", {
        tools: ["loom_profile"],
      });
      await tx.commit();

      const settled = await waitForCellValue<AgentResult>(
        runtime,
        result,
        (value) => typeof value?.error === "string",
      );
      await runtime.settled();

      expect(settled.error).toContain("INVALID_INPUT");
      expect(settled.error).toContain("loom_profile");
      expect(settled.pending).toBe(false);
      expect(result.withTx().key("run").get()).toBeUndefined();
    });

    it("stages and stays queued when no runner is registered", async () => {
      setUp();
      const result = runAgentPattern("agent-tool-no-runner", {
        tools: ["loom_profile"],
      });
      await tx.commit();

      const record = await waitForRecord(result);

      expect(record.get()?.state).toBe("queued");
      expect(record.get()?.tools).toEqual(["loom_profile"]);
      expect(result.withTx().key("error").get()).toBeUndefined();
    });
  });
});
