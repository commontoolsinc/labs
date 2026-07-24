/**
 * Pins the brand/path filtering of the materializer envelope collector
 * (`collectWritableCellArgumentLinks`): only `cell`/`writeonly`-branded
 * argument-schema positions whose paths overlap `materializerWriteInputPaths`
 * become envelopes. Stream-branded positions never do — a stream send writes
 * no address, so a send-classified write path in the metadata must not
 * materialize an envelope at the stream address. This is the runner half of
 * the transformer-side emission pin ("send-only computed keeps stream paths
 * in write metadata but never brands them collectible" in ts-transformers'
 * pipeline-regressions).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "materializer envelope collection",
);
const space = signer.did();

describe("materializer envelope collection", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const collect = (
    argumentSchema: unknown,
    inputs: unknown,
    resultCell: unknown,
    writeInputPaths?: readonly (readonly string[])[],
  ): NormalizedFullLink[] =>
    // deno-lint-ignore no-explicit-any
    (runtime.runner as any).collectWritableCellArgumentLinks(
      argumentSchema,
      inputs,
      resultCell,
      writeInputPaths,
    );

  const setup = () => {
    const resultCell = runtime.getCell(space, "envelope-result");
    const notifyCell = runtime.getCell(space, "envelope-notify-stream");
    const targetCell = runtime.getCell<number>(space, "envelope-target");
    const argumentSchema = {
      type: "object",
      properties: {
        notify: { asCell: ["stream"] },
        target: { type: "number", asCell: ["cell"] },
      },
    };
    const inputs = {
      notify: notifyCell.getAsWriteRedirectLink({ base: resultCell }),
      target: targetCell.getAsWriteRedirectLink({ base: resultCell }),
    };
    return { resultCell, targetCell, argumentSchema, inputs };
  };

  it("collects cell-branded write paths but prunes stream-branded ones", () => {
    const { resultCell, targetCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, resultCell, [
      ["notify"],
      ["target"],
    ]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });

  it("collects nothing for a send-only write-path set", () => {
    // The send-only computed shape: analyzed write metadata names only the
    // stream. The cell-branded arg does not path-match, the stream path does
    // not brand-match — "collect none" is the correct, precise result (more
    // precise than the opaque-result fallback's collect-all-writable-args).
    const { resultCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, resultCell, [
      ["notify"],
    ]);
    expect(envelopes).toEqual([]);
  });

  it("collects the cell-branded path when the metadata names it alone", () => {
    const { resultCell, targetCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, resultCell, [
      ["target"],
    ]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });
});

// The branch at the runner's envelope-derivation site: presence of
// materializerWriteInputPaths switches envelope collection off the
// opaque-result fallback (collect ALL writable args) onto the path-filtered
// collector — for a send-only computed with an unwritten writable arg, that
// flips "collect all" to "collect none". Intended precision: with analyzed
// write metadata, writable args that were never written would appear in the
// write paths if written. Pinned here at the only level where the branch
// selection is observable (the scheduler's materializer index after a real
// runner-driven run).
describe("materializer envelope branch selection", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const triConditionPattern = (withWriteMetadata: boolean) => ({
    argumentSchema: {
      type: "object",
      properties: {
        notifyArg: { type: "object" },
        targetArg: { type: "number" },
      },
    },
    resultSchema: {},
    result: { out: { $alias: { partialCause: "out", path: [] } } },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: () => 42,
          argumentSchema: {
            type: "object",
            properties: {
              notify: { asCell: ["stream"] },
              target: { type: "number", asCell: ["cell"] },
            },
          },
          resultSchema: { asCell: ["opaque"] },
          ...(withWriteMetadata
            ? { materializerWriteInputPaths: [["notify"]] }
            : {}),
        },
        inputs: {
          notify: { $alias: { cell: "argument", path: ["notifyArg"] } },
          target: { $alias: { cell: "argument", path: ["targetArg"] } },
        },
        outputs: { $alias: { partialCause: "out", path: [] } },
      },
    ],
  });

  const materializerIndex = () =>
    (runtime.scheduler as unknown as {
      materializers: {
        materializers: Set<unknown>;
        materializersByEntity: Map<string, Set<unknown>>;
      };
    }).materializers;

  const runPattern = async (withWriteMetadata: boolean) => {
    const resultCell = runtime.getCell(
      space,
      `branch-selection-${withWriteMetadata}`,
    );
    const result = runtime.run(
      undefined,
      trustExecutable(
        runtime,
        triConditionPattern(withWriteMetadata) as never,
      ),
      { notifyArg: {}, targetArg: 1 } as never,
      resultCell as never,
    );
    await result.pull();
    await runtime.idle();
  };

  it("send-only write metadata suppresses the opaque-result fallback", async () => {
    await runPattern(true);
    // The stream path does not brand-match and the writable arg does not
    // path-match: no envelopes, so the action never registers as a
    // materializer.
    expect(materializerIndex().materializers.size).toBe(0);
  });

  it("without write metadata the opaque-result fallback collects writable args", async () => {
    await runPattern(false);
    const index = materializerIndex();
    expect(index.materializers.size).toBe(1);
    // The registered envelope addresses the writable arg's backing entity.
    expect(index.materializersByEntity.size).toBeGreaterThan(0);
  });
});
