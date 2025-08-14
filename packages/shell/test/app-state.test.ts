import { describe, it } from "@std/testing/bdd";
import {
  AppState,
  AppStateSerialized,
  deserialize,
  serialize,
} from "../src/lib/app/mod.ts";
import { Identity, serializeKeyPairRaw } from "@commontools/identity";
import { assert } from "@std/assert";

const API_URL = "http://common.test/";
const SPACE_NAME = "common-knowledge";

describe("AppState", () => {
  it("serialize", async () => {
    const state: AppState = {
      apiUrl: new URL(API_URL),
      spaceName: SPACE_NAME,
    };

    let serialized = serialize(state);
    assert(serialized.apiUrl === API_URL);
    assert(serialized.spaceName === SPACE_NAME);
    assert(
      serialized.identity === undefined,
      "Identity not provided (undefined).",
    );

    state.identity = await Identity.generate({ implementation: "webcrypto" }),
      serialized = serialize(state);
    assert(serialized.apiUrl === API_URL);
    assert(serialized.spaceName === SPACE_NAME);
    assert(
      serialized.identity === null,
      "WebCrypto keys cannot be serialized (null).",
    );

    state.identity = await Identity.generate({ implementation: "noble" });
    serialized = serialize(state);
    assert(serialized.apiUrl === API_URL);
    assert(serialized.spaceName === SPACE_NAME);
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
      spaceName: SPACE_NAME,
    };

    let state = await deserialize(serialized);
    assert(state.apiUrl.toString() === API_URL.toString());
    assert(state.spaceName === SPACE_NAME);
    assert(state.identity === undefined);

    serialized.identity = identityRaw;
    state = await deserialize(serialized);
    assert(state.apiUrl.toString() === API_URL.toString());
    assert(state.spaceName === SPACE_NAME);
    assert(state.identity?.did() === identity.did(), "deserializes identity.");
  });
});
