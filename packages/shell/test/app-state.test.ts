import { describe, it } from "@std/testing/bdd";
import {
  applyCommand,
  AppState,
  AppStateSerialized,
  deserialize,
  serialize,
} from "@commontools/shell/shared";
import { Identity, serializeKeyPairRaw } from "@commontools/identity";
import { assert } from "@std/assert";

const API_URL = "http://common.test/";
const SPACE_NAME = "common-knowledge";

describe("AppState", () => {
  it("serialize", async () => {
    const state: AppState = {
      apiUrl: new URL(API_URL),
      view: {
        spaceName: SPACE_NAME,
      },
      config: {},
    };

    let serialized = serialize(state);
    assert(serialized.apiUrl === API_URL);
    assert((serialized.view as { spaceName: string }).spaceName === SPACE_NAME);
    assert(
      serialized.identity === undefined,
      "Identity not provided (undefined).",
    );

    state.identity = await Identity.generate({ implementation: "webcrypto" }),
      serialized = serialize(state);
    assert(serialized.apiUrl === API_URL);
    assert((serialized.view as { spaceName: string }).spaceName === SPACE_NAME);
    assert(
      serialized.identity === null,
      "WebCrypto keys cannot be serialized (null).",
    );

    state.identity = await Identity.generate({ implementation: "noble" });
    serialized = serialize(state);
    assert(serialized.apiUrl === API_URL);
    assert((serialized.view as { spaceName: string }).spaceName === SPACE_NAME);
    assert(serialized.identity);
    assert(
      (await Identity.fromRaw(Uint8Array.from(serialized.identity.privateKey)))
        .did() ===
        state.identity.did(),
      "Insecure keys are serializable.",
    );
  });

  it("deserialize", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const identityRaw = serializeKeyPairRaw(identity.serialize());
    assert(identityRaw, "Deserialized, transferrable identity.");

    const serialized: AppStateSerialized = {
      apiUrl: API_URL,
      view: { spaceName: SPACE_NAME },
      config: {},
    };

    let state = await deserialize(serialized);
    assert(state.apiUrl.toString() === API_URL.toString());
    assert((state.view as { spaceName: string }).spaceName === SPACE_NAME);
    assert(state.identity === undefined);

    serialized.identity = identityRaw;
    state = await deserialize(serialized);
    assert(state.apiUrl.toString() === API_URL.toString());
    assert((state.view as { spaceName: string }).spaceName === SPACE_NAME);
    assert(state.identity?.did() === identity.did(), "deserializes identity.");
  });

  it("clears charm list view when activating a charm", () => {
    const initial: AppState = {
      apiUrl: new URL(API_URL),
      view: { builtin: "home" },
      config: {
        showShellCharmListView: true,
      },
    };

    const next = applyCommand(initial, {
      type: "set-view",
      view: {
        spaceName: SPACE_NAME,
        pieceId: "example",
      },
    });

    assert(next.config.showShellCharmListView === false);
  });
});
