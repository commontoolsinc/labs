import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("issue-3297 repro");
const space = signer.did();

describe("issue 3297 repro", () => {
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
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("restores a missing stream marker for a manual handler recipe with no transformer involvement", async () => {
    const recipe: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { value: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: {
          eventCount: { type: "number" },
        },
      },
      initial: {
        internal: {
          myHandler: { $stream: true },
          eventCount: 0,
        },
      },
      result: {
        eventCount: { $alias: { path: ["internal", "eventCount"] } },
        myHandler: { $alias: { path: ["internal", "myHandler"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (_event: unknown, ctx: { eventCount: number }) => {
              ctx.eventCount = (ctx.eventCount || 0) + 1;
            },
          },
          inputs: {
            $event: { $alias: { path: ["internal", "myHandler"] } },
            $ctx: {
              eventCount: { $alias: { path: ["internal", "eventCount"] } },
            },
          },
          outputs: {
            eventCount: { $alias: { path: ["internal", "eventCount"] } },
          },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "issue-3297-repro");

    await runtime.setup(
      undefined,
      trustExecutable(runtime, recipe),
      { value: 1 },
      resultCell,
    );
    await runtime.start(resultCell);
    await resultCell.pull();
    runtime.runner.stop(resultCell);

    const processCell = resultCell.getSourceCell()!;
    const tx = runtime.edit();
    const raw = processCell.withTx(tx).getRawUntyped({
      frozen: false,
    }) as Record<string, unknown>;
    processCell.withTx(tx).setRawUntyped({
      ...raw,
      internal: { ...(raw.internal as Record<string, unknown>), myHandler: null },
    });
    tx.commit();

    await runtime.start(resultCell);
    const result = await resultCell.pull();
    expect(result).toBeDefined();

    const restored = processCell.getRawUntyped() as Record<string, unknown>;
    expect(restored.internal).toMatchObject({
      myHandler: { $stream: true },
    });
  });
});
