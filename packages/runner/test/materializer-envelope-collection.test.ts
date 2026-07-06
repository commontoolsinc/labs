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
    processCell: unknown,
    writeInputPaths?: readonly (readonly string[])[],
  ): NormalizedFullLink[] =>
    // deno-lint-ignore no-explicit-any
    (runtime.runner as any).collectWritableCellArgumentLinks(
      argumentSchema,
      inputs,
      processCell,
      writeInputPaths,
    );

  const setup = () => {
    const processCell = runtime.getCell(space, "envelope-process");
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
      notify: notifyCell.getAsWriteRedirectLink({ base: processCell }),
      target: targetCell.getAsWriteRedirectLink({ base: processCell }),
    };
    return { processCell, targetCell, argumentSchema, inputs };
  };

  it("collects cell-branded write paths but prunes stream-branded ones", () => {
    const { processCell, targetCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, processCell, [
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
    const { processCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, processCell, [
      ["notify"],
    ]);
    expect(envelopes).toEqual([]);
  });

  it("collects the cell-branded path when the metadata names it alone", () => {
    const { processCell, targetCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, processCell, [
      ["target"],
    ]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });
});
