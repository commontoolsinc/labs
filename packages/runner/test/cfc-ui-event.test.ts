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
});
