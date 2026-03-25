import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import {
  cfcLabelsAddress,
  normalizePersistedPathLabels,
  resolveObservationLabel,
} from "../src/cfc/shared.ts";
import { codeHashImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import { type JSONSchema, UI } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc ui output trust test");
const space = signer.did();

const uiPatternHash = "sha256:trusted-ui-parent-pattern";
const uiCodeHashAtom = {
  type: "https://commonfabric.org/cfc/atom/CodeHash",
  hash: uiPatternHash,
} as const;

const uiPlacementAtom = {
  type: "https://commonfabric.org/cfc/atom/UiPlacement",
  surface: "InboxList",
  slot: "message-row",
} as const;

const uiActionContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiActionContract",
  action: "ShareWithUser",
} as const;

const trustedUiConcept =
  "https://commonfabric.org/cfc/concepts/trusted-message-row-ui";

const uiDelegationSchema = {
  type: "object",
  properties: {
    [UI]: {
      type: "object",
      properties: {
        type: { type: "string" },
        text: { type: "string" },
        children: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                ifc: {
                  addIntegrity: [uiActionContractAtom],
                },
              },
            },
            ifc: {
              addIntegrity: [uiPlacementAtom],
            },
          },
        },
      },
    },
  },
  required: [UI],
} as const satisfies JSONSchema;

const trustedUiReadSchema = {
  type: "string",
  ifc: {
    requiredIntegrity: [trustedUiConcept],
  },
} as const satisfies JSONSchema;

type UiOutputValue = {
  $UI: {
    type: string;
    text: string;
    children: Array<{ action: string }>;
  };
};

describe("CFC UI output trust", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcTrustContext: {
        delegations: [{
          delegator: signer.did(),
          verifier: "did:key:ui-contract-verifier",
          scope: {
            concepts: [trustedUiConcept],
          },
        }],
        statements: [{
          verifier: "did:key:ui-contract-verifier",
          concrete: uiCodeHashAtom,
          concept: trustedUiConcept,
        }],
      },
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedUiOutput(
    id: string,
    value: UiOutputValue,
  ): Promise<URI> {
    const tx = runtime.edit();
    const cell = runtime.getCell<UiOutputValue>(
      space,
      id,
      uiDelegationSchema,
      tx,
    );
    const link = cell.getAsNormalizedFullLink();
    cell.set(value);

    await prepareCfcCommitIfNeeded(tx, {
      implementationIdentity: codeHashImplementationIdentity(uiPatternHash),
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
    return link.id;
  }

  async function readPersistedLabels(id: URI) {
    const tx = runtime.edit();
    const labels = tx.readOrThrow(cfcLabelsAddress({
      space,
      id,
      type: "application/json",
    }));
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
    return normalizePersistedPathLabels(labels);
  }

  it("injects implementation identity into UI output labels and composes wildcard child delegation", async () => {
    const sourceId = await seedUiOutput("ui-output-delegation", {
      [UI]: {
        type: "div",
        text: "hello",
        children: [{ action: "share" }],
      },
    });

    const persistedLabels = await readPersistedLabels(sourceId);

    expect(
      resolveObservationLabel(
        persistedLabels,
        `/${UI}`,
        "shape",
      )?.integrity,
    ).toEqual(expect.arrayContaining([uiCodeHashAtom]));
    expect(
      resolveObservationLabel(
        persistedLabels,
        `/${UI}/children/7/action`,
        "value",
      )?.integrity,
    ).toEqual(expect.arrayContaining([
      uiCodeHashAtom,
      uiPlacementAtom,
      uiActionContractAtom,
    ]));
  });

  it("lets a verifier place the UI implementation on the trust lattice via its output code hash", async () => {
    await seedUiOutput("ui-output-trusted-read", {
      [UI]: {
        type: "div",
        text: "reviewed composer",
        children: [],
      },
    });

    const tx = runtime.edit();
    const source = runtime.getCell<{ $UI: { text: string } }>(
      space,
      "ui-output-trusted-read",
      uiDelegationSchema,
      tx,
    );
    const sink = runtime.getCell<string>(
      space,
      "ui-output-trusted-read-result",
      { type: "string" },
      tx,
    );

    const value = source.withTx(tx)
      .key(UI)
      .key("text")
      .asSchema(trustedUiReadSchema)
      .get();
    sink.set(String(value ?? ""));

    await expect(prepareCfcCommitIfNeeded(tx)).resolves.toBeUndefined();
  });
});
