import { assert, assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { Identity, serializeKeyPairRaw } from "@commonfabric/identity";
import {
  AppState,
  AppStateSerialized,
  appViewToUrlPath,
  assertIdentityChangeAllowed,
  deserialize,
  isAppStateConfigKey,
  isAppView,
  isEmbeddedView,
  isViewingDefaultPatternView,
  preserveAppViewMode,
  resolveIdentity,
  serialize,
  urlToAppView,
} from "@commonfabric/shell/shared";

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

  it("parses and serializes slug piece routes", () => {
    assert(
      JSON.stringify(urlToAppView(new URL("http://common.test/space/demo"))) ===
        JSON.stringify({ spaceName: "space", pieceSlug: "demo" }),
    );
    assert(
      JSON.stringify(
        urlToAppView(new URL("http://common.test/space/fid1:abc")),
      ) === JSON.stringify({ spaceName: "space", pieceId: "fid1:abc" }),
    );
    assert(
      JSON.stringify(
        urlToAppView(new URL("http://common.test/space/of:fid1:abc")),
      ) === JSON.stringify({ spaceName: "space", pieceId: "of:fid1:abc" }),
    );
    assert(
      appViewToUrlPath({ spaceName: "space", pieceSlug: "demo" }) ===
        "/space/demo",
    );
  });

  it("captures ?path= as a one-shot openPath deep link", () => {
    assert(
      JSON.stringify(
        urlToAppView(
          new URL(
            "http://common.test/space/loom?path=People%2FZora%2Fabout.md",
          ),
        ),
      ) === JSON.stringify({
        spaceName: "space",
        pieceSlug: "loom",
        openPath: "People/Zora/about.md",
      }),
    );
    // Never re-emitted: reloads and internal navigation stay clean.
    assert(
      appViewToUrlPath({
        spaceName: "space",
        pieceSlug: "loom",
        openPath: "People/Zora/about.md",
      }) === "/space/loom",
    );
    // No param, no field.
    assert(
      !("openPath" in urlToAppView(new URL("http://common.test/space/loom"))),
    );
  });

  it("parses and serializes embedded routes", () => {
    const spaceDid = "did:key:z6MkjosLwWEobyT9T6RqLTdaEhFrXAZUNkRZJuUae2ukgfEa";

    assert(
      JSON.stringify(
        urlToAppView(new URL("http://common.test/.embed/space/demo")),
      ) ===
        JSON.stringify({
          spaceName: "space",
          pieceSlug: "demo",
          mode: "embed",
        }),
    );
    assert(
      JSON.stringify(
        urlToAppView(new URL("http://common.test/.embed/space/fid1:abc")),
      ) ===
        JSON.stringify({
          spaceName: "space",
          pieceId: "fid1:abc",
          mode: "embed",
        }),
    );
    assert(
      JSON.stringify(
        urlToAppView(new URL(`http://common.test/.embed/${spaceDid}/demo`)),
      ) ===
        JSON.stringify({
          spaceDid,
          pieceSlug: "demo",
          mode: "embed",
        }),
    );
    assert(
      appViewToUrlPath({
        spaceName: "space",
        pieceSlug: "demo",
        mode: "embed",
      }) === "/.embed/space/demo",
    );
    assert(
      appViewToUrlPath({
        spaceDid,
        pieceId: "fid1:abc",
        mode: "embed",
      }) === `/.embed/${spaceDid}/fid1:abc`,
    );
    assert(
      appViewToUrlPath({
        spaceName: "space",
        pieceSlug: undefined,
        mode: "embed",
      }) === "/.embed/space",
    );
  });

  it("validates and preserves embedded view mode", () => {
    const current = {
      spaceName: "space",
      pieceSlug: "demo",
      mode: "embed",
    } as const;

    assert(isAppView(current));
    assert(isEmbeddedView(current));
    assert(
      JSON.stringify(
        preserveAppViewMode(current, {
          spaceName: "space",
          pieceId: "fid1:abc",
        }),
      ) ===
        JSON.stringify({
          spaceName: "space",
          pieceId: "fid1:abc",
          mode: "embed",
        }),
    );
    assert(
      JSON.stringify(
        preserveAppViewMode(current, {
          spaceName: "space",
          pieceId: "fid1:abc",
          mode: undefined,
        }),
      ) ===
        JSON.stringify({
          spaceName: "space",
          pieceId: "fid1:abc",
        }),
    );
    assert(!isAppView({ builtin: "home", mode: "embed" }));
    assert(!isAppView({ spaceName: "space", mode: "fullscreen" }));
  });

  it("treats slug piece routes as non-default pattern views", () => {
    assert(isViewingDefaultPatternView({ spaceName: "space" }) === true);
    assert(
      isViewingDefaultPatternView({
        spaceName: "space",
        pieceId: "fid1:abc",
      }) ===
        false,
    );
    assert(
      isViewingDefaultPatternView({ spaceName: "space", pieceSlug: "demo" }) ===
        false,
    );
  });
});
