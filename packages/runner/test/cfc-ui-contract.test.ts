import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { EventHandler } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  markRendererTrustedEvent,
  recordTrustedEventPolicyInputs,
  trustedEventMatchesUiContract,
  uiContractFromSchema,
} from "../src/cfc/ui-contract.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

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

const rendererEvent = <T extends Record<string, unknown>>(event: T): T => {
  markRendererTrustedEvent(event);
  return event;
};

describe("CFC UI contract matching", () => {
  it("matches UiAction contracts against trusted DOM dataset markers", () => {
    const contract = uiContractFromSchema({
      ...uiActionSchema,
    });

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
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
        }),
        contract,
      ),
    ).toBe(true);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
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
        }),
        contract,
      ),
    ).toBe(false);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
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
        }),
        contract,
      ),
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
      trustedEventMatchesUiContract(
        rendererEvent({
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
        }),
        contract,
      ),
    ).toBe(true);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
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
        }),
        contract,
      ),
    ).toBe(false);

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
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
        }),
        contract,
      ),
    ).toBe(false);
  });

  it("resolves UiAction contracts through local $defs refs", () => {
    const contract = uiContractFromSchema({
      $ref: "#/$defs/TrustedAction",
      $defs: {
        TrustedAction: trustedPatternUiActionSchema,
      },
    });

    expect(
      trustedEventMatchesUiContract(
        rendererEvent({
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
        }),
        contract,
      ),
    ).toBe(true);
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
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
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
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
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
      }),
    );
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });

  it("rejects public stream payloads that forge trusted DOM provenance", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });

    const sourceStream = runtime.getCell(
      space,
      "cfc-ui-contract-source-stream-forged-public-send",
      { asStream: true },
    );
    const protectedStream = runtime.getCell(
      space,
      "cfc-ui-contract-protected-stream-forged-public-send",
      { asStream: true },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-forged-public-send",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const protectedHandler = Object.assign(
      ((tx: IExtendedStorageTransaction) => {
        output.withTx(tx).set("forged");
      }) as EventHandler,
      {
        reads: [],
        writes: [output.getAsNormalizedFullLink()],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );
    const forwardHandler = Object.assign(
      ((tx: IExtendedStorageTransaction, event: unknown) => {
        protectedStream.withTx(tx).send(event);
      }) as EventHandler,
      {
        reads: [],
        writes: [],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancelProtected = runtime.scheduler.addEventHandler(
      protectedHandler,
      protectedStream.getAsNormalizedFullLink(),
    );
    const cancelForward = runtime.scheduler.addEventHandler(
      forwardHandler,
      sourceStream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(sourceStream.getAsNormalizedFullLink(), {
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

    expect(output.get()).toBeUndefined();
    cancelForward();
    cancelProtected();
  });

  it("records trusted event policy inputs for nested contracts from ancestor schemas", () => {
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [{
      kind: "schema",
      target: {
        space,
        scope: "space",
        id: "of:cfc-ui-contract-nested-document",
        path: [],
      },
      schema: {
        type: "object",
        properties: {
          argument: {
            type: "object",
            properties: {
              savedTitle: { $ref: "#/$defs/TrustedAction" },
            },
          },
        },
        $defs: {
          TrustedAction: trustedPatternUiActionSchema,
        },
      },
    }];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: "of:cfc-ui-contract-nested-document",
        path: ["argument", "savedTitle"],
      }],
      rendererEvent({
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
      }),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.target.space === space &&
        input.target.id === "of:cfc-ui-contract-nested-document" &&
        input.target.path.join("/") === "argument/savedTitle"
      ),
    ).toBe(true);
  });

  it("records trusted event policy inputs from linked handler event envelopes", () => {
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [{
      kind: "schema",
      target: {
        space,
        scope: "space",
        id: "of:cfc-ui-contract-linked-event-document",
        path: [],
      },
      schema: {
        type: "object",
        properties: {
          argument: {
            type: "object",
            properties: {
              savedTitle: { $ref: "#/$defs/TrustedAction" },
            },
          },
        },
        $defs: {
          TrustedAction: trustedPatternUiActionSchema,
        },
      },
    }];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };
    const rawTrustedEvent = {
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
    };
    const eventEnvelopeLink = {
      "/": {
        [LINK_V1_TAG]: {
          id: `data:application/json,${
            encodeURIComponent(JSON.stringify({
              value: { $event: rawTrustedEvent },
            }))
          }`,
          path: ["$event"],
          space,
        },
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: "of:cfc-ui-contract-linked-event-document",
        path: ["argument", "savedTitle"],
      }],
      rendererEvent(eventEnvelopeLink),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.eventId ===
          "trusted-event:click:of:cfc-ui-contract-linked-event-document:argument/savedTitle" &&
        input.target.id === "of:cfc-ui-contract-linked-event-document" &&
        input.target.path.join("/") === "argument/savedTitle"
      ),
    ).toBe(true);
  });

  it("uses handler event context aliases as UI contract schema hints", () => {
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };
    const rawTrustedEvent = {
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
    };
    const eventEnvelopeLink = {
      "/": {
        [LINK_V1_TAG]: {
          id: `data:application/json,${
            encodeURIComponent(JSON.stringify({
              value: {
                $ctx: {
                  savedTitle: {
                    $alias: {
                      cell: { "/": "cfc-ui-contract-context-document" },
                      path: ["argument", "savedTitle"],
                      schema: {
                        $ref: "#/$defs/TrustedAction",
                        $defs: {
                          TrustedAction: trustedPatternUiActionSchema,
                        },
                      },
                    },
                  },
                },
                $event: rawTrustedEvent,
              },
            }))
          }`,
          path: ["$event"],
          space,
        },
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: "of:cfc-ui-contract-context-document",
        path: ["argument", "savedTitle"],
      }],
      rendererEvent(eventEnvelopeLink),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.eventId ===
          "trusted-event:click:of:cfc-ui-contract-context-document:argument/savedTitle" &&
        input.target.id === "of:cfc-ui-contract-context-document" &&
        input.target.path.join("/") === "argument/savedTitle"
      ),
    ).toBe(true);
  });

  it("uses a single leaf $defs uiContract hint for exact write schemas", () => {
    const writePolicyInputs: Array<
      ReturnType<
        IExtendedStorageTransaction["getCfcState"]
      >["writePolicyInputs"][number]
    > = [{
      kind: "schema",
      target: {
        space,
        scope: "space",
        id: "of:cfc-ui-contract-leaf-defs-document",
        path: ["argument", "savedTitle"],
      },
      schema: {
        type: "unknown",
        $defs: {
          TrustedAction: trustedPatternUiActionSchema,
          UnrelatedRenderNode: { type: "object" },
        },
      },
    }];
    const tx = {
      getCfcState: () => ({ writePolicyInputs }),
      recordCfcWritePolicyInput: (
        input: typeof writePolicyInputs[number],
      ) => {
        writePolicyInputs.push(input);
      },
    };

    recordTrustedEventPolicyInputs(
      tx as unknown as IExtendedStorageTransaction,
      [{
        space,
        scope: "space",
        id: "of:cfc-ui-contract-leaf-defs-document",
        path: ["argument", "savedTitle"],
      }],
      rendererEvent({
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
      }),
    );

    expect(
      writePolicyInputs.some((input) =>
        input.kind === "trusted-event" &&
        input.target.id === "of:cfc-ui-contract-leaf-defs-document" &&
        input.target.path.join("/") === "argument/savedTitle"
      ),
    ).toBe(true);
  });

  it("commits trusted event writes when the handler write annotation is untyped", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
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
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
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
      }),
    );
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });

  it("commits trusted event writes discovered from the handler transaction", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-dynamic-write",
      { asStream: true },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-dynamic-write",
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
        writes: [],
        module: { type: "javascript" as const },
        pattern: {} as never,
      },
    );

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
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
      }),
    );
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });

  it("fails closed when trusted event markers are missing or mismatched", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
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
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        provenance: { origin: "dom", trusted: true },
        target: {
          dataset: {
            uiAction: "SubmitDirectCommand",
          },
        },
      }),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
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
      }),
    );
    await runtime.idle();

    expect(output.get()).toBeUndefined();
    cancel();
  });

  it("does not let one same-path uiContract satisfy a different contract", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-same-path-mismatch",
      { asStream: true },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-same-path-mismatch",
      {
        allOf: [
          trustedPatternUiActionSchema,
          {
            type: "string",
            ifc: {
              uiContract: {
                helper: "UiAction",
                action: "ApproveDifferentAction",
                trustedPattern: "TrustedDirectCommandSurface",
                requiredEventIntegrity: ["TrustedDirectCommandSurface"],
              },
            },
          },
        ],
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
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
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
      }),
    );
    await runtime.idle();

    expect(output.get()).toBeUndefined();
    cancel();
  });

  it("recovers after a mismatched trusted event is rejected", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });

    const stream = runtime.getCell(
      space,
      "cfc-ui-contract-stream-recover",
      { asStream: true },
    );
    const output = runtime.getCell(
      space,
      "cfc-ui-contract-output-recover",
      {
        type: "string",
        ifc: {
          ...trustedPatternUiActionSchema.ifc,
        },
      },
    );

    const handler = Object.assign(
      ((tx: IExtendedStorageTransaction, event: { value: string }) => {
        output.withTx(tx).set(event.value);
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
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        value: "rejected",
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
      }),
    );
    await runtime.idle();
    expect(output.get()).toBeUndefined();

    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      rendererEvent({
        type: "click",
        value: "accepted",
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
      }),
    );
    await runtime.idle();

    expect(output.get()).toBe("accepted");
    cancel();
  });
});
