import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { EventHandler } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  trustedEventMatchesUiContract,
  uiContractFromSchema,
} from "../src/cfc/ui-contract.ts";

const signer = await Identity.fromPassphrase("runner-cfc-ui-contract");
const space = signer.did();

const uiActionSchema = {
  type: "string",
  ifc: {
    uiContract: {
      helper: "UiAction",
      action: "SubmitDirectCommand",
    },
  },
} as const;

const trustedPatternUiActionSchema = {
  type: "string",
  ifc: {
    uiContract: {
      helper: "UiAction",
      action: "SubmitDirectCommand",
      trustedPattern: "TrustedDirectCommandSurface",
      requiredEventIntegrity: ["TrustedDirectCommandSurface"],
    },
  },
} as const;

describe("CFC UI contract matching", () => {
  it("matches UiAction contracts against trusted DOM dataset markers", () => {
    const contract = uiContractFromSchema({
      ...uiActionSchema,
    });

    expect(
      trustedEventMatchesUiContract({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }, contract),
    ).toBe(true);

    expect(
      trustedEventMatchesUiContract({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            uiContractDataset: {
              uiAction: "DifferentAction",
            },
          },
        },
      }, contract),
    ).toBe(false);

    expect(
      trustedEventMatchesUiContract({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
        },
        target: {
          dataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      }, contract),
    ).toBe(false);
  });

  it("requires renderer-attested trusted pattern provenance when declared", () => {
    const contract = uiContractFromSchema({
      ...trustedPatternUiActionSchema,
    });

    expect(
      trustedEventMatchesUiContract({
        type: "click",
        provenance: { origin: "dom", trusted: true },
      }, contract),
    ).toBe(false);

    expect(
      trustedEventMatchesUiContract({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }, contract),
    ).toBe(true);

    expect(
      trustedEventMatchesUiContract({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "UntrustedLookalikeSurface",
            eventIntegrity: ["TrustedDirectCommandSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }, contract),
    ).toBe(false);

    expect(
      trustedEventMatchesUiContract({
        type: "click",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "TrustedDirectCommandSurface",
            eventIntegrity: ["UntrustedLookalikeSurface"],
            uiContractDataset: {
              uiAction: "SubmitDirectCommand",
            },
          },
        },
      }, contract),
    ).toBe(false);
  });
});

describe("CFC trusted UI event enforcement", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("commits handler writes when trusted event markers match the schema uiContract", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream",
      { asStream: true },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("accepted");
      }) as EventHandler,
      {
        reads: [],
        writes: [output.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    });
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });

  it("commits trusted event writes when the handler write annotation is untyped", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-untyped-write",
      { asStream: true },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-untyped-write",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );
    const untypedWrite = { ...output.getAsNormalizedFullLink() };
    delete untypedWrite.schema;

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("accepted");
      }) as EventHandler,
      {
        reads: [],
        writes: [untypedWrite],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "TrustedDirectCommandSurface",
          eventIntegrity: ["TrustedDirectCommandSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    });
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });

  it("fails closed when trusted event markers are missing or mismatched", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-reject",
      { asStream: true },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-reject",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("rejected");
      }) as EventHandler,
      {
        reads: [],
        writes: [output.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {
      type: "click",
      provenance: { origin: "dom", trusted: true },
      target: {
        dataset: {
          uiAction: "SubmitDirectCommand",
        },
      },
    });
    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {
      type: "click",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "UntrustedLookalikeSurface",
          eventIntegrity: ["UntrustedLookalikeSurface"],
          uiContractDataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      },
    });
    await runtime.idle();

    expect(output.get()).toBeUndefined();
    cancel();
  });
});
