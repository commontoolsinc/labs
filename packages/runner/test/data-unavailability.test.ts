import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  DataUnavailable,
  type DataUnavailableReason,
} from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Module, Pattern } from "../src/builder/types.ts";
import { type Cell, createCell, getCellWithStatus } from "../src/cell.ts";
import { getDerivedInternalCell, parseLink } from "../src/link-utils.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
} from "../src/storage/interface.ts";
import {
  isInternalVerifierRead,
  isLinkResolutionProbe,
  isReadIgnoredForCommit,
  isReadIgnoredForScheduling,
} from "../src/storage/reactivity-log.ts";
import { trustExecutable, trustModule } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("data unavailability test");
const space = signer.did();
const remoteSpace = (await Identity.fromPassphrase(
  "data unavailability remote test",
)).did();

describe("JavaScript-node data unavailability", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let nextResultId = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function runValueNode(options: {
    argument: unknown;
    moduleType?: Module["type"];
    nodeInputs?: unknown;
    argumentSchema?: Module["argumentSchema"];
    resultSchema?: Module["resultSchema"];
    unavailableInputPolicy?: Module["unavailableInputPolicy"];
    implementation: (argument: any) => unknown;
    isEffect?: boolean;
    captureWrittenResult?: (value: unknown) => void;
    captureSelectedInput?: (value: unknown) => void;
    captureArgumentReads?: (reads: readonly IReadActivity[]) => void;
  }): Promise<unknown> {
    const module: Module = {
      type: options.moduleType ?? "javascript",
      implementation: options.implementation,
      ...(options.argumentSchema !== undefined && {
        argumentSchema: options.argumentSchema,
      }),
      ...(options.resultSchema !== undefined && {
        resultSchema: options.resultSchema,
      }),
      ...(options.unavailableInputPolicy !== undefined && {
        unavailableInputPolicy: options.unavailableInputPolicy,
      }),
      ...(options.isEffect !== undefined && { isEffect: options.isEffect }),
    };
    const pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: {
        output: { $alias: { partialCause: "output", path: [] } },
      },
      nodes: [{
        module,
        inputs: options.nodeInputs ?? {
          $alias: { cell: "argument", path: ["value"] },
        },
        outputs: { $alias: { partialCause: "output", path: [] } },
      }],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      `data unavailability result ${nextResultId++}`,
    );
    const runner = runtime.runner as unknown as {
      writeJavaScriptActionResult: (...args: any[]) => unknown;
      readJavaScriptArgument: (...args: any[]) => {
        unavailable?: unknown;
      };
    };
    const originalWrite = runner.writeJavaScriptActionResult;
    const originalRead = runner.readJavaScriptArgument;
    if (options.captureWrittenResult !== undefined) {
      runner.writeJavaScriptActionResult = function (...args: any[]) {
        options.captureWrittenResult!(args[2]);
        return originalWrite.apply(this, args);
      };
    }
    if (
      options.captureSelectedInput !== undefined ||
      options.captureArgumentReads !== undefined
    ) {
      runner.readJavaScriptArgument = function (...args: any[]) {
        const tx = args[2] as IExtendedStorageTransaction;
        const readCountBefore = [...(tx.getReadActivities?.() ?? [])].length;
        const result = originalRead.apply(this, args);
        options.captureSelectedInput?.(result.unavailable);
        options.captureArgumentReads?.(
          [...(tx.getReadActivities?.() ?? [])].slice(readCountBefore),
        );
        return result;
      };
    }
    try {
      const result = await runtime.runSynced(
        resultCell,
        trustExecutable(runtime, pattern),
        options.argument as never,
      );
      await result.pull();
      return getDerivedInternalCell(result, { partialCause: "output" })
        .getRaw();
    } finally {
      runner.writeJavaScriptActionResult = originalWrite;
      runner.readJavaScriptArgument = originalRead;
    }
  }

  it("executes the fail-closed module kind used by policy-bearing lifts", async () => {
    const error = DataUnavailable.error(new Error("observed"));
    const result = await runValueNode({
      argument: { value: error },
      moduleType: "javascript-availability",
      argumentSchema: {
        anyOf: [{ type: "string" }, { type: "object" }],
      },
      resultSchema: { type: "boolean" },
      unavailableInputPolicy: [{ path: [], reasons: ["error"] }],
      implementation: (value) =>
        value instanceof DataUnavailable && value.reason === "error",
    });

    expect(result).toBe(true);
  });

  it("rejects malformed serialized policy before invoking the callback", async () => {
    let calls = 0;
    await expect(runValueNode({
      argument: { value: "usable" },
      moduleType: "javascript-availability",
      argumentSchema: { type: "string" },
      unavailableInputPolicy: [{
        path: [],
        reasons: ["offline"],
      }] as unknown as Module["unavailableInputPolicy"],
      implementation: () => {
        calls++;
        return "called";
      },
    })).rejects.toThrow(/Invalid unavailable input policy/);
    expect(calls).toBe(0);
  });

  it("suppresses the callback and propagates the selected marker instance", async () => {
    const marker = DataUnavailable.error(new Error("upstream failed"));
    let calls = 0;
    let writtenResult: unknown;
    let selectedInput: unknown;

    const output = await runValueNode({
      argument: { value: marker },
      argumentSchema: { type: "number" },
      resultSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
      implementation: () => {
        calls++;
        return { answer: 42 };
      },
      captureWrittenResult: (value) => writtenResult = value,
      captureSelectedInput: (value) => selectedInput = value,
    });

    expect(calls).toBe(0);
    expect(selectedInput).toBeInstanceOf(DataUnavailable);
    expect(writtenResult).toBe(selectedInput);
    expect(output).toBeInstanceOf(DataUnavailable);
    expect((output as DataUnavailable).reason).toBe("error");
    expect((output as DataUnavailable).error?.message).toBe("upstream failed");
  });

  it("selects by reason precedence, then serialized argument order", async () => {
    const firstError = DataUnavailable.error(new Error("first"));
    const secondError = DataUnavailable.error(new Error("second"));
    let calls = 0;
    let writtenResult: unknown;
    let selectedInput: unknown;

    const output = await runValueNode({
      argument: {
        first: firstError,
        pending: DataUnavailable.pending(),
        syncing: DataUnavailable.syncing(),
        mismatch: DataUnavailable.schemaMismatch(),
        second: secondError,
      },
      nodeInputs: {
        first: { $alias: { cell: "argument", path: ["first"] } },
        pending: { $alias: { cell: "argument", path: ["pending"] } },
        syncing: { $alias: { cell: "argument", path: ["syncing"] } },
        mismatch: { $alias: { cell: "argument", path: ["mismatch"] } },
        second: { $alias: { cell: "argument", path: ["second"] } },
      },
      argumentSchema: {
        type: "object",
        properties: {
          first: { type: "object" },
          pending: { type: "object" },
          syncing: { type: "object" },
          mismatch: { type: "object" },
          second: { type: "object" },
        },
      },
      implementation: () => {
        calls++;
        return "ran";
      },
      captureWrittenResult: (value) => writtenResult = value,
      captureSelectedInput: (value) => selectedInput = value,
    });

    expect(calls).toBe(0);
    expect((selectedInput as DataUnavailable).error?.message).toBe("first");
    expect(writtenResult).toBe(selectedInput);
    expect((output as DataUnavailable).error?.message).toBe("first");

    const pending = DataUnavailable.pending();
    const pendingOutput = await runValueNode({
      argument: {
        syncing: DataUnavailable.syncing(),
        pending,
        mismatch: DataUnavailable.schemaMismatch(),
      },
      nodeInputs: {
        syncing: { $alias: { cell: "argument", path: ["syncing"] } },
        pending: { $alias: { cell: "argument", path: ["pending"] } },
        mismatch: { $alias: { cell: "argument", path: ["mismatch"] } },
      },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "ran";
      },
    });
    expect(pendingOutput).toBe(pending);

    const syncing = DataUnavailable.syncing();
    const syncingOutput = await runValueNode({
      argument: {
        mismatch: DataUnavailable.schemaMismatch(),
        syncing,
      },
      nodeInputs: {
        mismatch: { $alias: { cell: "argument", path: ["mismatch"] } },
        syncing: { $alias: { cell: "argument", path: ["syncing"] } },
      },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "ran";
      },
    });
    expect(syncingOutput).toBe(syncing);
    expect(calls).toBe(0);
  });

  it("allows only the accepted reason at the exact policy path", async () => {
    let calls = 0;
    let acceptedArgument: unknown;
    const nodeInputs = {
      value: { $alias: { cell: "argument", path: ["value"] } },
    };
    const argumentSchema = {
      type: "object" as const,
      properties: {
        value: {
          anyOf: [
            {
              type: "object" as const,
              properties: { answer: { type: "number" as const } },
              required: ["answer"],
            },
            { type: "object" as const },
          ],
        },
      },
      required: ["value"],
    };
    const unavailableInputPolicy = [{
      path: ["value"],
      reasons: ["error" as const],
    }];

    const observed = DataUnavailable.error(new Error("observable"));
    const acceptedOutput = await runValueNode({
      argument: { value: observed },
      nodeInputs,
      argumentSchema,
      unavailableInputPolicy,
      implementation: (argument) => {
        calls++;
        acceptedArgument = argument.value;
        return argument.value.error.message;
      },
    });

    expect(acceptedOutput).toBe("observable");
    expect(acceptedArgument).toBeInstanceOf(DataUnavailable);
    expect((acceptedArgument as DataUnavailable).reason).toBe("error");
    expect((acceptedArgument as DataUnavailable).error?.message).toBe(
      "observable",
    );
    expect(calls).toBe(1);

    const unaccepted = DataUnavailable.pending();
    const propagatedOutput = await runValueNode({
      argument: { value: unaccepted },
      nodeInputs,
      argumentSchema,
      unavailableInputPolicy,
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(propagatedOutput).toBe(unaccepted);
    expect(calls).toBe(1);
  });

  it("restores accepted markers at multiple object and array paths", async () => {
    const error = DataUnavailable.error(new Error("accepted error"));
    const pending = DataUnavailable.pending();

    const output = await runValueNode({
      argument: { first: error, list: [pending] },
      nodeInputs: {
        first: { $alias: { cell: "argument", path: ["first"] } },
        list: { $alias: { cell: "argument", path: ["list"] } },
      },
      argumentSchema: {
        type: "object",
        properties: {
          first: {
            anyOf: [{ type: "string" }, { type: "object" }],
          },
          list: {
            type: "array",
            items: {
              anyOf: [{ type: "number" }, { type: "object" }],
            },
          },
        },
        required: ["first", "list"],
      },
      unavailableInputPolicy: [
        { path: ["first"], reasons: ["error"] },
        { path: ["list", "0"], reasons: ["pending"] },
      ],
      implementation: (argument) => ({
        errorIsMarker: argument.first instanceof DataUnavailable,
        errorMessage: argument.first.error.message,
        pendingIsMarker: argument.list[0] instanceof DataUnavailable,
        pendingReason: argument.list[0].reason,
      }),
    });

    expect(output).toEqual({
      errorIsMarker: true,
      errorMessage: "accepted error",
      pendingIsMarker: true,
      pendingReason: "pending",
    });
  });

  it("preserves authored schemas and policy when resolving a ref module", async () => {
    let calls = 0;
    runtime.moduleRegistry.addModuleByRef(
      "availability-policy-ref",
      trustModule(runtime, {
        type: "javascript",
        argumentSchema: { type: "number" },
        resultSchema: { type: "number" },
        implementation: (value: DataUnavailable) => {
          calls++;
          return value.pending ? "observed through ref" : "unexpected";
        },
      }),
    );

    const pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: {
        output: { $alias: { partialCause: "output", path: [] } },
      },
      nodes: [{
        module: {
          type: "ref",
          implementation: "availability-policy-ref",
          argumentSchema: { type: "object" },
          resultSchema: { type: "string" },
          unavailableInputPolicy: [{ path: [], reasons: ["pending"] }],
        },
        inputs: { $alias: { cell: "argument", path: ["value"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      }],
    } as Pattern;
    const resultCell = runtime.getCell(
      space,
      `availability ref result ${nextResultId++}`,
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      { value: DataUnavailable.pending() },
    );
    await result.pull();

    expect(calls).toBe(1);
    expect(
      getDerivedInternalCell(result, { partialCause: "output" }).getRaw(),
    ).toBe("observed through ref");
  });

  it("does not let outer-path acceptance admit a nested marker", async () => {
    const nested = DataUnavailable.pending();
    let calls = 0;

    const output = await runValueNode({
      argument: { value: { nested } },
      nodeInputs: {
        value: { $alias: { cell: "argument", path: ["value"] } },
      },
      argumentSchema: {
        type: "object",
        properties: { value: { type: "object" } },
      },
      unavailableInputPolicy: [{
        path: ["value"],
        reasons: ["pending"],
      }],
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expect(output).toBe(nested);
  });

  it("checks each exact path when two aliases share one object", async () => {
    const nested = DataUnavailable.error(new Error("shared but unaccepted"));
    let calls = 0;

    const output = await runValueNode({
      argument: { shared: { nested } },
      nodeInputs: {
        accepted: { $alias: { cell: "argument", path: ["shared"] } },
        unaccepted: { $alias: { cell: "argument", path: ["shared"] } },
      },
      argumentSchema: {
        type: "object",
        properties: {
          accepted: { type: "object" },
          unaccepted: { type: "object" },
        },
      },
      unavailableInputPolicy: [{
        path: ["accepted", "nested"],
        reasons: ["error"],
      }],
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expect(output).toBeInstanceOf(DataUnavailable);
    expect((output as DataUnavailable).error?.message).toBe(
      "shared but unaccepted",
    );
  });

  it("preflights concrete markers before an object schema can accept them", async () => {
    const marker = DataUnavailable.pending();
    let calls = 0;

    const output = await runValueNode({
      argument: { value: marker },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expect(output).toBe(marker);
  });

  it("does not duplicate an ordinary linked target's effective read", async () => {
    const target = runtime.getCell<number>(
      space,
      `ordinary linked input ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    target.withTx(seedTx).set(41);
    await seedTx.commit();

    let reads: readonly IReadActivity[] = [];
    const output = await runValueNode({
      argument: { value: target.getAsLink() },
      argumentSchema: { type: "number" },
      implementation: (value: number) => value + 1,
      captureArgumentReads: (argumentReads) => reads = argumentReads,
    });

    expect(output).toBe(42);
    const targetId = target.getAsNormalizedFullLink().id;
    const contentReads = reads.filter((read) =>
      read.id === targetId && !isLinkResolutionProbe(read.meta)
    );
    const ordinaryReads = contentReads.filter((read) =>
      !isReadIgnoredForScheduling(read.meta) &&
      !isReadIgnoredForCommit(read.meta) &&
      !isInternalVerifierRead(read.meta)
    );
    expect(
      ordinaryReads.filter((read) => read.nonRecursive !== true),
    ).toHaveLength(0);
    expect(ordinaryReads).toHaveLength(2);

    const verifierReads = contentReads.filter((read) =>
      isReadIgnoredForScheduling(read.meta) &&
      isReadIgnoredForCommit(read.meta) &&
      isInternalVerifierRead(read.meta)
    );
    expect(verifierReads).toHaveLength(1);
  });

  it("keeps legacy schema modes subscribed to linked availability", async () => {
    for (
      const [label, argumentSchema] of [
        ["undefined", undefined],
        ["false", false],
      ] as const
    ) {
      const target = runtime.getCell<number | DataUnavailable>(
        space,
        `legacy availability target ${label} ${nextResultId++}`,
      );
      const seedTx = runtime.edit();
      target.withTx(seedTx).set(7);
      await seedTx.commit();

      let calls = 0;
      const pattern = {
        argumentSchema: {},
        resultSchema: {},
        result: {
          output: { $alias: { partialCause: "output", path: [] } },
        },
        nodes: [{
          module: {
            type: "javascript",
            ...(argumentSchema !== undefined && { argumentSchema }),
            implementation: () => `call ${++calls}`,
          },
          inputs: {
            ignored: { $alias: { cell: "argument", path: ["value"] } },
          },
          outputs: { $alias: { partialCause: "output", path: [] } },
        }],
      } as Pattern;
      const result = await runtime.runSynced(
        runtime.getCell(
          space,
          `legacy availability result ${label} ${nextResultId++}`,
        ),
        trustExecutable(runtime, pattern),
        { value: target.getAsLink() },
      );
      await result.pull();
      const output = getDerivedInternalCell(result, {
        partialCause: "output",
      });
      expect(output.getRaw()).toBe("call 1");

      const pendingTx = runtime.edit();
      target.withTx(pendingTx).set(DataUnavailable.pending());
      await pendingTx.commit();
      await output.pull();

      expect(calls).toBe(1);
      expect(output.getRaw()).toBe(DataUnavailable.pending());
    }
  });

  it("resolves a nested relative marker from the reached linked container", async () => {
    const holder = runtime.getCell(
      space,
      `relative availability holder ${nextResultId++}`,
    );
    const relativeMarker = holder.key("payload").getAsLink({
      base: holder.key("container", "nested"),
    });
    const seedTx = runtime.edit();
    holder.withTx(seedTx).setRaw({
      payload: DataUnavailable.pending(),
      container: { nested: relativeMarker },
    });
    await seedTx.commit();

    let calls = 0;
    const output = await runValueNode({
      argument: { value: holder.key("container").getAsLink() },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expect(output).toBe(DataUnavailable.pending());
  });

  it("terminates a linked-container cycle and still selects its sibling marker", async () => {
    const first = runtime.getCell(
      space,
      `availability cycle first ${nextResultId++}`,
    );
    const second = runtime.getCell(
      space,
      `availability cycle second ${nextResultId++}`,
    );
    const pending = DataUnavailable.pending();
    const seedTx = runtime.edit();
    first.withTx(seedTx).setRaw({
      next: second.getAsLink(),
      sibling: pending,
    });
    second.withTx(seedTx).setRaw({ next: first.getAsLink() });
    await seedTx.commit();

    let calls = 0;
    const output = await runValueNode({
      argument: { value: first.getAsLink() },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expect(output).toBe(pending);
  });

  it("writes schema-mismatch when locally complete input fails its schema", async () => {
    let calls = 0;

    const output = await runValueNode({
      argument: { value: "not a number" },
      argumentSchema: { type: "number" },
      implementation: () => {
        calls++;
        return 42;
      },
    });

    expect(calls).toBe(0);
    expect(output).toBe(DataUnavailable.schemaMismatch());
  });

  it("settles missing linked targets from syncing to schema mismatch", async () => {
    const remoteStates: string[] = [];
    const remoteWrites: string[] = [];
    const missingRemote = runtime.getCell(
      remoteSpace,
      `missing remote input ${nextResultId++}`,
    );
    const remoteOutput = await runValueNode({
      argument: { value: missingRemote.getAsLink() },
      argumentSchema: { type: "number" },
      implementation: () => "should not run",
      captureSelectedInput: (value) => {
        if (value instanceof DataUnavailable) remoteStates.push(value.reason);
      },
      captureWrittenResult: (value) => {
        if (value instanceof DataUnavailable) remoteWrites.push(value.reason);
      },
    });
    expect(remoteStates[0]).toBe("syncing");
    expect(remoteStates.at(-1)).toBe("schema-mismatch");
    expect(remoteWrites[0]).toBe("syncing");
    expect(remoteWrites.at(-1)).toBe("schema-mismatch");
    expect((remoteOutput as DataUnavailable).reason).toBe("schema-mismatch");

    const localStates: string[] = [];
    const localWrites: string[] = [];
    const missingLocal = runtime.getCell(
      space,
      `missing local input ${nextResultId++}`,
    );
    const localOutput = await runValueNode({
      argument: { value: missingLocal.getAsLink() },
      argumentSchema: { type: "number" },
      implementation: () => "should not run",
      captureSelectedInput: (value) => {
        if (value instanceof DataUnavailable) localStates.push(value.reason);
      },
      captureWrittenResult: (value) => {
        if (value instanceof DataUnavailable) localWrites.push(value.reason);
      },
    });
    expect(localStates[0]).toBe("syncing");
    expect(localStates.at(-1)).toBe("schema-mismatch");
    expect(localWrites[0]).toBe("syncing");
    expect(localWrites.at(-1)).toBe("schema-mismatch");
    expect((localOutput as DataUnavailable).reason).toBe("schema-mismatch");
  });

  it("selects syncing ahead of a concrete schema mismatch", async () => {
    const writes: DataUnavailableReason[] = [];
    const missingRemote = runtime.getCell(
      remoteSpace,
      `precedence missing remote ${nextResultId++}`,
    );
    let calls = 0;

    const output = await runValueNode({
      argument: {
        mismatch: DataUnavailable.schemaMismatch(),
        missing: missingRemote.getAsLink(),
      },
      nodeInputs: {
        mismatch: { $alias: { cell: "argument", path: ["mismatch"] } },
        missing: { $alias: { cell: "argument", path: ["missing"] } },
      },
      argumentSchema: {
        type: "object",
        properties: {
          mismatch: { type: "number" },
          missing: { type: "number" },
        },
        required: ["mismatch", "missing"],
      },
      implementation: () => {
        calls++;
        return "should not run";
      },
      captureWrittenResult: (value) => {
        if (value instanceof DataUnavailable) writes.push(value.reason);
      },
    });

    expect(calls).toBe(0);
    expect(writes[0]).toBe("syncing");
    expect(writes.at(-1)).toBe("schema-mismatch");
    expect(output).toBe(DataUnavailable.schemaMismatch());
  });

  it("passes policy-accepted readiness syncing to the callback", async () => {
    const missingRemote = runtime.getCell(
      remoteSpace,
      `accepted syncing remote ${nextResultId++}`,
    );
    const writes: unknown[] = [];
    let calls = 0;

    const output = await runValueNode({
      argument: { value: missingRemote.getAsLink() },
      moduleType: "javascript-availability",
      argumentSchema: {
        anyOf: [{ type: "number" }, { type: "object" }],
      },
      unavailableInputPolicy: [{ path: [], reasons: ["syncing"] }],
      implementation: (value) => {
        calls++;
        expect(value).toBe(DataUnavailable.syncing());
        return "observed syncing";
      },
      captureWrittenResult: (value) => writes.push(value),
    });

    expect(calls).toBe(1);
    expect(writes[0]).toBe("observed syncing");
    expect(output).toBe(DataUnavailable.schemaMismatch());
  });

  it("still rejects a sibling mismatch beside accepted readiness syncing", async () => {
    const missingRemote = runtime.getCell(
      remoteSpace,
      `accepted nested syncing remote ${nextResultId++}`,
    );
    const writes: unknown[] = [];
    let calls = 0;

    const output = await runValueNode({
      argument: {
        missing: missingRemote.getAsLink(),
        invalid: "not a number",
      },
      nodeInputs: {
        missing: { $alias: { cell: "argument", path: ["missing"] } },
        invalid: { $alias: { cell: "argument", path: ["invalid"] } },
      },
      moduleType: "javascript-availability",
      argumentSchema: {
        type: "object",
        properties: {
          missing: {
            anyOf: [{ type: "number" }, { type: "object" }],
          },
          invalid: { type: "number" },
        },
        required: ["missing", "invalid"],
      },
      unavailableInputPolicy: [{
        path: ["missing"],
        reasons: ["syncing"],
      }],
      implementation: () => {
        calls++;
        return "should not run";
      },
      captureWrittenResult: (value) => writes.push(value),
    });

    expect(calls).toBe(0);
    expect(writes[0]).toBe(DataUnavailable.schemaMismatch());
    expect(output).toBe(DataUnavailable.schemaMismatch());
  });

  it("tracks missing-link readiness by full selector identity", async () => {
    type Link = Parameters<Runtime["ensureLinkedDocLoaded"]>[0];
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    const observed: Link[] = [];
    const releases: Array<() => void> = [];
    storageManager.syncCell = <T>(cell: Cell<T>): Promise<Cell<T>> => {
      observed.push(cell.getAsNormalizedFullLink());
      const { promise, resolve } = Promise.withResolvers<void>();
      releases.push(resolve);
      return promise.then(() => cell);
    };

    try {
      const base = runtime.getCell(
        space,
        `selector readiness ${nextResultId++}`,
      ).getAsNormalizedFullLink();
      const selectors: Link[] = [
        {
          ...base,
          scope: "space",
          path: ["left"],
          schema: { type: "string" },
        },
        {
          ...base,
          scope: "user",
          path: ["left"],
          schema: { type: "string" },
        },
        {
          ...base,
          scope: "space",
          path: ["right"],
          schema: { type: "string" },
        },
        {
          ...base,
          scope: "space",
          path: ["left"],
          schema: { type: "number" },
        },
      ];

      for (const [index, selector] of selectors.entries()) {
        expect(runtime.ensureLinkedDocLoaded(selector)).toBe("pending");
        expect(observed.length).toBe(index + 1);
        releases[index]();
        await storageManager.crossSpaceSettled();
        expect(runtime.ensureLinkedDocLoaded(selector)).toBe("settled");
      }

      // Structural schema identity is canonical: reminting an equivalent
      // selector must reuse its settled coverage rather than issue a fifth sync.
      expect(runtime.ensureLinkedDocLoaded({
        ...selectors[0],
        schema: { type: "string" },
      })).toBe("settled");
      expect(observed.length).toBe(selectors.length);
    } finally {
      for (const release of releases) release();
      await storageManager.crossSpaceSettled();
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("prefetches cross-space link targets without registering an action waiter", async () => {
    const source = runtime.getCell(
      space,
      `reference-only prefetch source ${nextResultId++}`,
    );
    const target = runtime.getCell(
      remoteSpace,
      `reference-only prefetch target ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    source.withTx(seedTx).setRaw(target.getAsLink());
    await seedTx.commit();

    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) {
        started.resolve();
        await release.promise;
        return cell;
      }
      return await originalSyncCell(cell);
    };

    const scheduler = runtime.scheduler;
    const originalSchedule = scheduler.scheduleExternalDependencySettlement;
    let settlementSchedules = 0;
    scheduler.scheduleExternalDependencySettlement = (token) => {
      settlementSchedules++;
      return originalSchedule.call(scheduler, token);
    };

    try {
      const readTx = runtime.edit();
      const action = (() => {}) as Parameters<
        typeof scheduler.withExecutingAction
      >[0];
      const resolved = scheduler.withExecutingAction(
        action,
        () =>
          resolveLink(
            runtime,
            readTx,
            source.getAsNormalizedFullLink(),
          ),
      );

      expect(resolved.space).toBe(remoteSpace);
      await started.promise;
      release.resolve();
      await storageManager.crossSpaceSettled();
      expect(settlementSchedules).toBe(0);
    } finally {
      release.resolve();
      scheduler.scheduleExternalDependencySettlement = originalSchedule;
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("can verify cross-space link topology without starting a prefetch", async () => {
    const source = runtime.getCell(
      space,
      `no-prefetch source ${nextResultId++}`,
    );
    const target = runtime.getCell(
      remoteSpace,
      `no-prefetch target ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    source.withTx(seedTx).setRaw(target.getAsLink());
    await seedTx.commit();

    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let targetSyncs = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) targetSyncs++;
      return await originalSyncCell(cell);
    };

    const readTx = runtime.edit();
    try {
      const resolved = resolveLink(
        runtime,
        readTx,
        source.getAsNormalizedFullLink(),
        "value",
        { prefetch: false },
      );
      expect(resolved.space).toBe(remoteSpace);
      expect(targetSyncs).toBe(0);
      expect((await readTx.commit()).ok).toBeDefined();
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("retries a rejected linked-target sync and wakes the consumer", async () => {
    const target = runtime.getCell(
      space,
      `reject once target ${nextResultId++}`,
    );
    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let attempts = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) {
        attempts++;
        // The first call is runSynced's static input presync. Reject the second,
        // readiness-owned call so the retry loop itself is under test.
        if (attempts === 2) throw new Error("transient selector failure");
      }
      return await originalSyncCell(cell);
    };

    try {
      const states: string[] = [];
      const output = await runValueNode({
        argument: { value: target.getAsLink() },
        argumentSchema: { type: "number" },
        implementation: () => "should not run",
        captureWrittenResult: (value) => {
          if (value instanceof DataUnavailable) states.push(value.reason);
        },
      });

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(states[0]).toBe("syncing");
      expect(states.at(-1)).toBe("schema-mismatch");
      expect(output).toBe(DataUnavailable.schemaMismatch());
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("wakes a same-space consumer when its delayed target arrives", async () => {
    const target = runtime.getCell<number>(
      space,
      `delayed same-space target ${nextResultId++}`,
    );
    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let intercepted = false;
    let targetSyncs = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) targetSyncs++;
      const readinessOwned =
        runtime.scheduler.getExecutingActionToken() !== undefined;
      if (readinessOwned && !intercepted) {
        intercepted = true;
        started.resolve();
        await release.promise;
      }
      return await originalSyncCell(cell);
    };

    try {
      const writes: unknown[] = [];
      const outputPromise = runValueNode({
        argument: { value: target.getAsLink() },
        argumentSchema: { type: "number" },
        implementation: (value: number) => value,
        captureWrittenResult: (value) => writes.push(value),
      });

      await started.promise;
      const targetTx = runtime.edit();
      target.withTx(targetTx).set(42);
      await targetTx.commit();
      release.resolve();

      expect(await outputPromise).toBe(42);
      // Scheduler-v2 may finish the same-space load gate before the action's
      // first observable write, so the transient marker is not guaranteed to
      // be externally visible. The consumer must still wait and converge.
      expect(writes).not.toContain(DataUnavailable.schemaMismatch());
      expect(writes.at(-1)).toBe(42);
    } finally {
      release.resolve();
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("does not wake an effect for a target from an obsolete action run", async () => {
    const targetA = runtime.getCell<number>(
      space,
      `stale waiter target a ${nextResultId++}`,
    );
    const targetB = runtime.getCell<number>(
      space,
      `stale waiter target b ${nextResultId++}`,
    );
    const selector = runtime.getCell(
      space,
      `stale waiter selector ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    targetB.withTx(seedTx).set(7);
    selector.withTx(seedTx).setRaw(targetA.getAsLink());
    await seedTx.commit();

    const targetAId = targetA.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let targetASyncs = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetAId) targetASyncs++;
      if (runtime.scheduler.getExecutingActionToken() !== undefined) {
        started.resolve();
        await release.promise;
      }
      return await originalSyncCell(cell);
    };

    try {
      let calls = 0;
      const writes: unknown[] = [];
      const outputPromise = runValueNode({
        argument: { value: selector.getAsLink() },
        argumentSchema: { type: "number" },
        isEffect: true,
        implementation: (value: number) => {
          calls++;
          return value;
        },
        captureWrittenResult: (value) => writes.push(value),
      });

      await started.promise;
      const retargetTx = runtime.edit();
      selector.withTx(retargetTx).setRaw(targetB.getAsLink());
      await retargetTx.commit();
      for (let turn = 0; turn < 10 && calls === 0; turn++) {
        await runtime.idle();
        await Promise.resolve();
      }
      expect(calls).toBe(1);

      // Settling A belongs to the earlier action generation. It must not run
      // the now-B-dependent effect for a third time.
      release.resolve();
      expect(await outputPromise).toBe(7);
      await runtime.idle();
      expect(calls).toBe(1);
      expect(writes.at(-1)).toBe(7);
    } finally {
      release.resolve();
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("bounds readiness retries while the provider stays offline", async () => {
    const target = runtime.getCell(
      space,
      `offline readiness target ${nextResultId++}`,
    );
    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let attempts = 0;
    let readinessAttempts = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) {
        attempts++;
        // Let runSynced's static input presync complete. Every attempt owned by
        // the executing availability action then fails as if the provider
        // stayed offline. This remains stable as presync adds coverage passes.
        if (runtime.scheduler.getExecutingActionToken() !== undefined) {
          readinessAttempts++;
          throw new Error("provider offline");
        }
      }
      return await originalSyncCell(cell);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = runValueNode({
        argument: { value: target.getAsLink() },
        argumentSchema: { type: "number" },
        isEffect: true,
        implementation: () => "should not run",
      });
      const bounded = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("offline readiness did not settle")),
          2_000,
        );
      });
      const output = await Promise.race([run, bounded]);
      expect(output).toBeInstanceOf(DataUnavailable);
      expect((output as DataUnavailable).reason).toBe("error");

      const probe = runtime.getCell(
        space,
        `offline readiness probe ${nextResultId++}`,
      );
      const writeTx = runtime.edit();
      probe.withTx(writeTx).setRaw(target.getAsLink());
      await writeTx.commit();
      const readTx = runtime.edit();
      const terminal = getCellWithStatus(
        probe.asSchema({ type: "number" }).withTx(readTx),
      );
      expect("error" in terminal).toBe(true);
      if (!("error" in terminal)) throw new Error("expected traversal error");
      expect(terminal.unavailableReason).toBe("error");
      expect(terminal.unavailableError?.message).toBe(
        "provider offline",
      );
      await readTx.commit();
      // Reference prefetch and value materialization use distinct full
      // selectors; each independently exhausts the three-attempt bound.
      expect(readinessAttempts).toBe(6);
      expect(attempts).toBeGreaterThanOrEqual(readinessAttempts);
      expect(storageManager.pendingCrossSpacePromiseCount()).toBe(0);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("executes for authored undefined when the declared schema admits it", async () => {
    let calls = 0;

    const output = await runValueNode({
      argument: { value: undefined },
      argumentSchema: { type: "undefined" },
      implementation: (argument) => {
        calls++;
        expect(argument).toBeUndefined();
        return "valid undefined";
      },
    });

    expect(calls).toBe(1);
    expect(output).toBe("valid undefined");
  });

  it("preserves a required nested undefined admitted by an anyOf schema", async () => {
    const output = await runValueNode({
      argument: {
        value: {
          result: undefined,
          candidates: [],
        },
      },
      argumentSchema: {
        type: "object",
        properties: {
          result: {
            anyOf: [
              { type: "undefined" },
              { type: "object", asCell: ["cell"] },
            ],
          },
          candidates: { type: "array", items: true },
        },
        required: ["result", "candidates"],
      },
      implementation: (argument) => ({
        ownsResult: Object.hasOwn(argument, "result"),
        result: argument.result,
      }),
    });

    expect(output).toEqual({
      ownsResult: true,
      result: undefined,
    });
  });

  it("suppresses value-producing effects while propagating unavailable input", async () => {
    const marker = DataUnavailable.syncing();
    let externalActions = 0;

    const output = await runValueNode({
      argument: { value: marker },
      argumentSchema: { type: "number" },
      isEffect: true,
      implementation: () => {
        externalActions++;
        return 42;
      },
    });

    expect(externalActions).toBe(0);
    expect(output).toBe(marker);
  });

  it("uses the normal input-derived scope when writing a propagated marker", async () => {
    const inputTx = runtime.edit();
    const inputBase = runtime.getCell(
      space,
      `availability scoped input ${nextResultId++}`,
      undefined,
      inputTx,
    );
    const input = createCell<DataUnavailable>(
      runtime,
      { ...inputBase.getAsNormalizedFullLink(), scope: "user" },
      inputTx,
    );
    input.setRaw(DataUnavailable.pending());
    await inputTx.commit();

    const pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: {
        output: { $alias: { partialCause: "output", path: [] } },
      },
      nodes: [{
        module: {
          type: "javascript",
          argumentSchema: { type: "number" },
          implementation: () => 42,
        },
        inputs: { $alias: { cell: "argument", path: ["value"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      }],
    } as Pattern;
    const resultCell = runtime.getCell(
      space,
      `availability scoped result ${nextResultId++}`,
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      { value: input },
    );
    await result.pull();

    const internal = getDerivedInternalCell(result, {
      partialCause: "output",
    });
    const scopedOutputLink = parseLink(internal.getRaw(), internal);
    expect(scopedOutputLink?.scope).toBe("user");
    expect(
      runtime.getCellFromLink(scopedOutputLink!).getRaw(),
    ).toBe(DataUnavailable.pending());
  });

  it("replays a gated handler event once its captured input is available", async () => {
    let calls = 0;
    const valueAlias = {
      $alias: {
        cell: "argument",
        path: ["value"],
        scope: "space",
        schema: { type: "object" },
      },
    };
    const streamCause = { stream: "availability-handler" };
    const streamAlias = {
      $alias: {
        partialCause: streamCause,
        path: [],
        scope: "space",
        schema: true,
      },
    };
    const pattern = {
      argumentSchema: {},
      resultSchema: {
        type: "object",
        properties: {
          trigger: { asCell: ["stream", "opaque"] },
        },
      },
      derivedInternalCells: [{
        partialCause: streamCause,
        schema: { default: { $stream: true } },
        scope: "space",
      }],
      result: { trigger: streamAlias },
      nodes: [{
        module: {
          type: "javascript",
          wrapper: "handler",
          argumentSchema: {
            type: "object",
            properties: {
              $event: { type: "object" },
              $ctx: {
                type: "object",
                properties: { value: { type: "number" } },
              },
            },
            required: ["$ctx", "$event"],
          },
          implementation: () => {
            calls++;
          },
        },
        inputs: {
          $ctx: { value: valueAlias },
          $event: streamAlias,
        },
        outputs: {},
      }],
    } as Pattern;
    const resultCell = runtime.getCell<any>(
      space,
      `availability handler ${nextResultId++}`,
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      { value: DataUnavailable.pending() },
    );

    const eventCommitted = Promise.withResolvers<string>();
    result.key("trigger").send(
      {},
      (committedTx) => eventCommitted.resolve(committedTx.status().status),
    );

    const settledWhileUnavailable = await Promise.race([
      eventCommitted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    expect(settledWhileUnavailable).toBe(false);
    expect(calls).toBe(0);

    const syncingTx = runtime.edit();
    result.getArgumentCell()!.withTx(syncingTx).key("value").setRaw(
      DataUnavailable.syncing(),
    );
    await syncingTx.commit();
    const settledWhileSyncing = await Promise.race([
      eventCommitted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(settledWhileSyncing).toBe(false);
    expect(calls).toBe(0);

    // Async producers wait for scheduler quiescence before publishing. A
    // parked handler must not hold idle() open, or the producer write which
    // wakes this event can never happen.
    const producerWrite = (async () => {
      await runtime.idle();
      const updateTx = runtime.edit();
      result.getArgumentCell()!.withTx(updateTx).key("value").set(7);
      await updateTx.commit();
    })();
    await Promise.race([
      producerWrite,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("parked handler deadlocked its producer")),
          1000,
        )
      ),
    ]);
    const commitStatus = await Promise.race([
      eventCommitted.promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("gated handler event did not replay")),
          1000,
        )
      ),
    ]);
    expect(commitStatus).toBe("done");
    await runtime.idle();
    await result.pull();
    expect(calls).toBe(1);

    const invalidEventCommitted = Promise.withResolvers<string>();
    const followingEventCommitted = Promise.withResolvers<string>();
    result.key("trigger").send(
      "invalid event",
      (committedTx) =>
        invalidEventCommitted.resolve(committedTx.status().status),
    );
    result.key("trigger").send(
      {},
      (committedTx) =>
        followingEventCommitted.resolve(committedTx.status().status),
    );
    const queuedStatuses = await Promise.race([
      Promise.all([
        invalidEventCommitted.promise,
        followingEventCommitted.promise,
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("malformed event blocked the handler queue")),
          1000,
        )
      ),
    ]);
    expect(queuedStatuses).toEqual(["done", "done"]);
    await runtime.idle();
    expect(calls).toBe(2);

    for (
      const terminal of [
        DataUnavailable.error(new Error("terminal handler input")),
        DataUnavailable.schemaMismatch(),
      ]
    ) {
      const terminalTx = runtime.edit();
      result.getArgumentCell()!.withTx(terminalTx).key("value").setRaw(
        terminal,
      );
      await terminalTx.commit();

      const terminalCommitted = Promise.withResolvers<string>();
      result.key("trigger").send(
        {},
        (committedTx) => terminalCommitted.resolve(committedTx.status().status),
      );
      const status = await Promise.race([
        terminalCommitted.promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `${terminal.reason} handler input blocked the event queue`,
                ),
              ),
            1000,
          )
        ),
      ]);
      expect(status).toBe("done");
      expect(calls).toBe(2);
    }
  });
});
