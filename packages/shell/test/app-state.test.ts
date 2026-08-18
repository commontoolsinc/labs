import { assert, assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { Identity, serializeKeyPairRaw } from "@commonfabric/identity";
import {
  AppState,
  AppStateSerialized,
  assertIdentityChangeAllowed,
  clone,
  createAppState,
  deserialize,
  isAppStateConfigKey,
  resolveIdentity,
  serialize,
} from "@commonfabric/shell/app-state";

const API_URL = "http://common.test/";
const SPACE_NAME = "common-knowledge";

describe("AppState", () => {
  it("requires logout before switching identities", async () => {
    const first = await Identity.generate({ implementation: "noble" });
    const second = await Identity.generate({ implementation: "noble" });

    assertThrows(
      () => assertIdentityChangeAllowed(first, second),
      Error,
      "Cannot change identity while logged in",
    );

    // Clearing an identity, and re-establishing one from nothing, are both
    // allowed; so is re-establishing the identity already in place.
    assertIdentityChangeAllowed(first, undefined);
    assertIdentityChangeAllowed(undefined, second);
    assertIdentityChangeAllowed(first, first);
  });

  it("accepts only the four display toggles as config keys", () => {
    assert(isAppStateConfigKey("showShellPieceListView"));
    assert(isAppStateConfigKey("showDebuggerView"));
    assert(isAppStateConfigKey("showQuickJumpView"));
    assert(isAppStateConfigKey("showSidebar"));
    assert(!isAppStateConfigKey("identity"));
    assert(!isAppStateConfigKey("__proto__"));
    assert(!isAppStateConfigKey(""));
    assert(!isAppStateConfigKey(undefined));
    assert(!isAppStateConfigKey(0));
  });

  it("clones the config and the view rather than sharing them", () => {
    const original: AppState = {
      apiUrl: new URL(API_URL),
      view: { spaceName: SPACE_NAME, pieceSlug: "demo" },
      config: { showSidebar: true },
    };

    const copy = clone(original);
    assertEquals(copy.view, original.view);
    assertEquals(copy.config, original.config);
    assert(copy.config !== original.config, "the config is a fresh record.");
    assert(copy.view !== original.view, "the view is a fresh record.");

    copy.config.showSidebar = false;
    (copy.view as { spaceName: string }).spaceName = "elsewhere";
    assertEquals(original.config.showSidebar, true);
    assertEquals(
      (original.view as { spaceName: string }).spaceName,
      SPACE_NAME,
    );
  });

  it("carries a built-in view through a clone", () => {
    const original = createAppState({
      apiUrl: new URL(API_URL),
      view: { builtin: "home" },
      identity: undefined,
    });
    assertEquals(original.config, {});
    assertEquals(clone(original).view, { builtin: "home" });
  });

  it("resolves an identity from either an Identity or a raw key pair", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const raw = serializeKeyPairRaw(identity.serialize());
    assert(raw, "Insecure keys are serializable.");

    assertEquals(await resolveIdentity(undefined), undefined);
    assert(await resolveIdentity(identity) === identity);
    assertEquals((await resolveIdentity(raw))?.did(), identity.did());
  });

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
});
