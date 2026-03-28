import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema, UI } from "../src/builder/types.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { codeHashImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import { dispatchUiEvent, resolveUiEventTarget } from "../src/cfc/ui-event.ts";
import type { CfcEventEnvelope } from "../src/cfc/event-envelope.ts";

const signer = await Identity.fromPassphrase("cfc ui event test");
const space = signer.did();

const uiPatternHash = "sha256:trusted-ui-click-pattern";
const uiCodeHashAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash",
  hash: uiPatternHash,
} as const;

const submitActionContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiActionContract",
  action: "SubmitDirectCommand",
} as const;

const disclosureContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiDisclosureContract",
  kind: "DirectCommandMayTriggerTools",
} as const;

const promptSlotContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiPromptSlotContract",
  surface: "AssistantComposer",
  role: "direct-command",
} as const;

const disclosureRenderedAtom = {
  type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
  kind: "DirectCommandMayTriggerTools",
} as const;

const promptSlotBoundAtom = {
  type: "https://commonfabric.org/cfc/atom/PromptSlotBound",
  surface: "AssistantComposer",
  role: "direct-command",
} as const;

const userSurfaceInputAtom = {
  type: "https://commonfabric.org/cfc/atom/UserSurfaceInput",
  user: space,
  surface: "AssistantComposer",
  role: "direct-command",
} as const;

const gestureProvenanceAtom = {
  type: "https://commonfabric.org/cfc/atom/GestureProvenance",
  targetPath: `/${UI}/children/2`,
} as const;

const messageRowPlacementAtom = {
  type: "https://commonfabric.org/cfc/atom/UiPlacement",
  surface: "InboxList",
  slot: "message-row",
} as const;

const shareActionContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiActionContract",
  action: "ShareReviewedMessage",
} as const;

const uiSchema = {
  type: "object",
  properties: {
    [UI]: {
      type: "object",
      properties: {
        props: { type: "object" },
        children: {
          type: "array",
          prefixItems: [
            {
              type: "object",
              ifc: {
                addIntegrity: [submitActionContractAtom],
              },
              properties: {
                props: {
                  type: "object",
                  properties: {
                    "data-ui-action": { type: "string" },
                    onClick: true,
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  required: [UI],
} as const satisfies JSONSchema;

const directCommandContextUiSchema = {
  type: "object",
  properties: {
    [UI]: {
      type: "object",
      properties: {
        children: {
          type: "array",
          prefixItems: [
            {
              type: "object",
              ifc: {
                addIntegrity: [disclosureContractAtom],
              },
            },
            {
              type: "object",
              ifc: {
                addIntegrity: [promptSlotContractAtom],
              },
            },
            {
              type: "object",
              ifc: {
                addIntegrity: [submitActionContractAtom],
              },
              properties: {
                props: {
                  type: "object",
                  properties: {
                    "data-ui-action": { type: "string" },
                    onClick: true,
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  required: [UI],
} as const satisfies JSONSchema;

const nestedChildUiPatternHash = "sha256:trusted-ui-share-row";
const nestedChildCodeHashAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash",
  hash: nestedChildUiPatternHash,
} as const;

const nestedChildUiSchema = {
  type: "object",
  properties: {
    [UI]: {
      type: "object",
      properties: {
        children: {
          type: "array",
          prefixItems: [{
            type: "object",
            ifc: {
              addIntegrity: [shareActionContractAtom],
            },
            properties: {
              props: {
                type: "object",
                properties: {
                  "data-ui-action": { type: "string" },
                  onClick: true,
                },
              },
            },
          }],
        },
      },
    },
  },
  required: [UI],
} as const satisfies JSONSchema;

const nestedParentUiSchema = {
  type: "object",
  properties: {
    [UI]: {
      type: "object",
      properties: {
        children: {
          type: "array",
          prefixItems: [
            { type: "object" },
            { type: "object" },
            {
              type: "object",
              properties: {
                children: {
                  type: "array",
                  items: {
                    type: "object",
                    ifc: {
                      addIntegrity: [messageRowPlacementAtom],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  required: [UI],
} as const satisfies JSONSchema;

describe("CFC UI event minting", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function createClickStream(id: string) {
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(space, id, undefined, tx);
    cell.set({ $stream: true });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
    return runtime.getCell<unknown>(space, id, undefined);
  }

  async function seedUiOutput(id: string, clickStream: unknown) {
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(space, id, uiSchema, tx);
    cell.set({
      [UI]: {
        type: "vnode",
        name: "ct-vstack",
        props: {},
        children: [{
          type: "vnode",
          name: "ct-button",
          props: {
            "data-ui-action": "SubmitDirectCommand",
            onClick: clickStream,
          },
          children: ["Submit direct command"],
        }],
      },
    });
    await prepareCfcCommitIfNeeded(tx, {
      implementationIdentity: codeHashImplementationIdentity(uiPatternHash),
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
    return runtime.getCell<unknown>(space, id, uiSchema);
  }

  async function seedDirectCommandContextUiOutput(
    id: string,
    clickStream: unknown,
  ) {
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(
      space,
      id,
      directCommandContextUiSchema,
      tx,
    );
    cell.set({
      [UI]: {
        type: "vnode",
        name: "ct-vstack",
        props: {},
        children: [
          {
            type: "vnode",
            name: "ct-card",
            props: {
              "data-ui-disclosure-kind": "DirectCommandMayTriggerTools",
            },
            children: ["Disclosure"],
          },
          {
            type: "vnode",
            name: "ct-textarea",
            props: {
              "data-ui-role": "direct-command",
              "data-ui-surface": "AssistantComposer",
            },
            children: [],
          },
          {
            type: "vnode",
            name: "ct-button",
            props: {
              "data-ui-action": "SubmitDirectCommand",
              onClick: clickStream,
            },
            children: ["Submit direct command"],
          },
        ],
      },
    });
    await prepareCfcCommitIfNeeded(tx, {
      implementationIdentity: codeHashImplementationIdentity(uiPatternHash),
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
    return runtime.getCell<unknown>(space, id, directCommandContextUiSchema);
  }

  async function seedNestedChildUiOutput(id: string, clickStream: unknown) {
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(space, id, nestedChildUiSchema, tx);
    cell.set({
      [UI]: {
        type: "vnode",
        name: "ct-card",
        props: {},
        children: [{
          type: "vnode",
          name: "ct-button",
          props: {
            "data-ui-action": "ShareReviewedMessage",
            onClick: clickStream,
          },
          children: ["Share reviewed message"],
        }],
      },
    });
    await prepareCfcCommitIfNeeded(tx, {
      implementationIdentity: codeHashImplementationIdentity(
        nestedChildUiPatternHash,
      ),
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
    return runtime.getCell<unknown>(space, id, nestedChildUiSchema);
  }

  async function seedNestedParentUiOutput(
    id: string,
    rowOutputs: readonly unknown[],
  ) {
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(space, id, nestedParentUiSchema, tx);
    cell.set({
      [UI]: {
        type: "vnode",
        name: "ct-vstack",
        props: {},
        children: [
          {
            type: "vnode",
            name: "h2",
            props: {},
            children: ["Mapped child-slot delegation example"],
          },
          {
            type: "vnode",
            name: "p",
            props: {},
            children: ["Parent-composed mapped children"],
          },
          {
            type: "vnode",
            name: "ct-vstack",
            props: { gap: "2" },
            children: [rowOutputs],
          },
        ],
      },
    });
    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
    return runtime.getCell<unknown>(space, id, nestedParentUiSchema);
  }

  it("mints a CFC event envelope from declared UI labels and delivers it to the handler", async () => {
    const clickStream = await createClickStream("ui-click-stream");
    const targetCell = await seedUiOutput("ui-click-target", clickStream);

    const resolved = await resolveUiEventTarget(runtime, targetCell, {
      attr: {
        name: "data-ui-action",
        value: "SubmitDirectCommand",
      },
    });

    expect(resolved.nodePath).toBe(`/${UI}/children/0`);
    expect(resolved.integrity).toEqual(expect.arrayContaining([
      uiCodeHashAtom,
      submitActionContractAtom,
    ]));
    expect(resolved.envelope.evidence).toMatchObject({
      uiEvent: "click",
      uiNodePath: `/${UI}/children/0`,
    });

    let deliveredEvent: CfcEventEnvelope<unknown> | undefined;
    let deliveredPayload: unknown;
    runtime.scheduler.addEventHandler(
      (tx, payload) => {
        deliveredEvent = tx.currentCfcEvent;
        deliveredPayload = payload;
      },
      clickStream.getAsNormalizedFullLink(),
    );

    await dispatchUiEvent(runtime, targetCell, {
      attr: {
        name: "data-ui-action",
        value: "SubmitDirectCommand",
      },
      sourceGestureId: "gesture-direct-command-test",
    });
    await runtime.scheduler.idle();

    expect(deliveredPayload).toEqual({ type: "click" });
    expect(deliveredEvent?.sourceGestureId).toBe("gesture-direct-command-test");
    expect(deliveredEvent?.integrity).toEqual(expect.arrayContaining([
      uiCodeHashAtom,
      submitActionContractAtom,
    ]));
  });

  it("traverses parent-composed mapped child UI and joins parent placement with child action integrity", async () => {
    const firstClickStream = await createClickStream("mapped-share-stream-1");
    const secondClickStream = await createClickStream("mapped-share-stream-2");
    const firstRow = await seedNestedChildUiOutput(
      "mapped-share-row-1",
      firstClickStream,
    );
    const secondRow = await seedNestedChildUiOutput(
      "mapped-share-row-2",
      secondClickStream,
    );
    const parentTarget = await seedNestedParentUiOutput(
      "mapped-share-parent",
      [firstRow, secondRow],
    );

    const resolved = await resolveUiEventTarget(runtime, parentTarget, {
      attr: {
        name: "data-ui-action",
        value: "ShareReviewedMessage",
      },
      occurrence: 0,
    });

    expect(resolved.nodePath).toBe(`/${UI}/children/0`);
    expect(resolved.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: `/${UI}/children/2/children/0/0`,
      }),
    ]));
    expect(resolved.integrity).toEqual(expect.arrayContaining([
      messageRowPlacementAtom,
      nestedChildCodeHashAtom,
      shareActionContractAtom,
    ]));

    let deliveredEvent: CfcEventEnvelope<unknown> | undefined;
    let deliveredPayload: unknown;
    runtime.scheduler.addEventHandler(
      (tx, payload) => {
        deliveredEvent = tx.currentCfcEvent;
        deliveredPayload = payload;
      },
      firstClickStream.getAsNormalizedFullLink(),
    );

    await dispatchUiEvent(runtime, parentTarget, {
      attr: {
        name: "data-ui-action",
        value: "ShareReviewedMessage",
      },
      occurrence: 0,
      sourceGestureId: "gesture-mapped-share-row-test",
    });
    await runtime.scheduler.idle();

    expect(deliveredPayload).toEqual({ type: "click" });
    expect(deliveredEvent?.sourceGestureId).toBe(
      "gesture-mapped-share-row-test",
    );
    expect(deliveredEvent?.integrity).toEqual(expect.arrayContaining([
      messageRowPlacementAtom,
      nestedChildCodeHashAtom,
      shareActionContractAtom,
    ]));
  });

  it("derives prompt-slot and disclosure event integrity from the surrounding trusted UI surface", async () => {
    const clickStream = await createClickStream(
      "ui-direct-command-context-stream",
    );
    const targetCell = await seedDirectCommandContextUiOutput(
      "ui-direct-command-context-target",
      clickStream,
    );

    const resolved = await resolveUiEventTarget(runtime, targetCell, {
      attr: {
        name: "data-ui-action",
        value: "SubmitDirectCommand",
      },
    });

    expect(resolved.integrity).toEqual(expect.arrayContaining([
      uiCodeHashAtom,
      submitActionContractAtom,
      promptSlotBoundAtom,
      disclosureRenderedAtom,
    ]));

    let deliveredEvent: CfcEventEnvelope<unknown> | undefined;
    runtime.scheduler.addEventHandler(
      (tx) => {
        deliveredEvent = tx.currentCfcEvent;
      },
      clickStream.getAsNormalizedFullLink(),
    );

    await dispatchUiEvent(runtime, targetCell, {
      attr: {
        name: "data-ui-action",
        value: "SubmitDirectCommand",
      },
      sourceGestureId: "gesture-direct-command-context-test",
    });
    await runtime.scheduler.idle();

    expect(deliveredEvent?.integrity).toEqual(expect.arrayContaining([
      uiCodeHashAtom,
      submitActionContractAtom,
      userSurfaceInputAtom,
      gestureProvenanceAtom,
      promptSlotBoundAtom,
      disclosureRenderedAtom,
    ]));
  });
});
