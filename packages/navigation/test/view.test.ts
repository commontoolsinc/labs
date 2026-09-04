import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  appViewToUrlPath,
  isAppView,
  isAppViewEqual,
  isEmbeddedView,
  isViewingDefaultPatternView,
  preserveAppViewMode,
  urlToAppView,
} from "@commonfabric/navigation";

const SPACE_DID = "did:key:z6MkjosLwWEobyT9T6RqLTdaEhFrXAZUNkRZJuUae2ukgfEa";

describe("view", () => {
  it("parses and serializes slug piece routes", () => {
    expect(urlToAppView(new URL("http://common.test/space/demo"))).toEqual({
      spaceName: "space",
      pieceSlug: "demo",
    });
    expect(urlToAppView(new URL("http://common.test/space/fid1:abc"))).toEqual({
      spaceName: "space",
      pieceId: "fid1:abc",
    });
    expect(urlToAppView(new URL("http://common.test/space/of:fid1:abc")))
      .toEqual({ spaceName: "space", pieceId: "of:fid1:abc" });
    expect(appViewToUrlPath({ spaceName: "space", pieceSlug: "demo" })).toBe(
      "/space/demo",
    );
  });

  it("parses and serializes a collection member route", () => {
    expect(urlToAppView(new URL("http://common.test/space/top/42"))).toEqual({
      spaceName: "space",
      pieceSlug: "top",
      pieceMember: "42",
    });
    expect(urlToAppView(new URL(`http://common.test/${SPACE_DID}/top/42`)))
      .toEqual({ spaceDid: SPACE_DID, pieceSlug: "top", pieceMember: "42" });
    expect(
      appViewToUrlPath({
        spaceName: "space",
        pieceSlug: "top",
        pieceMember: "42",
      }),
    ).toBe("/space/top/42");
    expect(
      appViewToUrlPath({
        spaceDid: SPACE_DID,
        pieceSlug: "top",
        pieceMember: "42",
      }),
    ).toBe(`/${SPACE_DID}/top/42`);
  });

  it("reads one segment after a slug as the member", () => {
    // A member's own fields are a cell path inside the piece it resolves to,
    // so nothing past the first segment is part of the address.
    expect(urlToAppView(new URL("http://common.test/space/top/42/title")))
      .toEqual({ spaceName: "space", pieceSlug: "top", pieceMember: "42" });
    // An id names its piece outright, and member names belong to collections.
    expect(urlToAppView(new URL("http://common.test/space/fid1:abc/42")))
      .toEqual({ spaceName: "space", pieceId: "fid1:abc" });
  });

  it("routes a bare origin to the home view", () => {
    expect(urlToAppView(new URL("http://common.test/"))).toEqual({
      builtin: "home",
    });
    expect(appViewToUrlPath({ builtin: "home" })).toBe("/");
  });

  it("parses a space addressed by DID", () => {
    expect(urlToAppView(new URL(`http://common.test/${SPACE_DID}`))).toEqual({
      spaceDid: SPACE_DID,
    });
    expect(appViewToUrlPath({ spaceDid: SPACE_DID })).toBe(`/${SPACE_DID}`);
  });

  it("captures ?path= as a one-shot openPath deep link", () => {
    expect(
      urlToAppView(
        new URL("http://common.test/space/loom?path=People%2FZora%2Fabout.md"),
      ),
    ).toEqual({
      spaceName: "space",
      pieceSlug: "loom",
      openPath: "People/Zora/about.md",
    });
    // Never re-emitted: reloads and internal navigation stay clean.
    expect(
      appViewToUrlPath({
        spaceName: "space",
        pieceSlug: "loom",
        openPath: "People/Zora/about.md",
      }),
    ).toBe("/space/loom");
    // No param, no field.
    expect(urlToAppView(new URL("http://common.test/space/loom"))).toEqual({
      spaceName: "space",
      pieceSlug: "loom",
    });
  });

  it("parses and serializes embedded routes", () => {
    expect(urlToAppView(new URL("http://common.test/.embed/space/demo")))
      .toEqual({ spaceName: "space", pieceSlug: "demo", mode: "embed" });
    expect(urlToAppView(new URL("http://common.test/.embed/space/fid1:abc")))
      .toEqual({ spaceName: "space", pieceId: "fid1:abc", mode: "embed" });
    expect(urlToAppView(new URL(`http://common.test/.embed/${SPACE_DID}/demo`)))
      .toEqual({ spaceDid: SPACE_DID, pieceSlug: "demo", mode: "embed" });
    expect(
      appViewToUrlPath({
        spaceName: "space",
        pieceSlug: "demo",
        mode: "embed",
      }),
    ).toBe("/.embed/space/demo");
    expect(
      appViewToUrlPath({
        spaceDid: SPACE_DID,
        pieceId: "fid1:abc",
        mode: "embed",
      }),
    ).toBe(`/.embed/${SPACE_DID}/fid1:abc`);
    expect(
      appViewToUrlPath({
        spaceName: "space",
        pieceSlug: undefined,
        mode: "embed",
      }),
    ).toBe("/.embed/space");
  });

  it("validates and preserves embedded view mode", () => {
    const current = {
      spaceName: "space",
      pieceSlug: "demo",
      mode: "embed",
    } as const;

    expect(isAppView(current)).toBe(true);
    expect(isEmbeddedView(current)).toBe(true);
    expect(
      preserveAppViewMode(current, { spaceName: "space", pieceId: "fid1:abc" }),
    ).toEqual({ spaceName: "space", pieceId: "fid1:abc", mode: "embed" });
    // A next view that names `mode` itself is taken at its word.
    const explicit = preserveAppViewMode(current, {
      spaceName: "space",
      pieceId: "fid1:abc",
      mode: undefined,
    });
    expect(isEmbeddedView(explicit)).toBe(false);
    expect(isAppView({ builtin: "home", mode: "embed" })).toBe(false);
    expect(isAppView({ spaceName: "space", mode: "fullscreen" })).toBe(false);
  });

  it("leaves a non-embedded view unembedded", () => {
    expect(
      preserveAppViewMode({ spaceName: "space" }, { spaceName: "other" }),
    ).toEqual({ spaceName: "other" });
    expect(
      preserveAppViewMode(
        { spaceName: "space", mode: "embed" },
        { builtin: "home" },
      ),
    ).toEqual({ builtin: "home" });
  });

  it("rejects a view that is neither a space nor a built-in", () => {
    expect(isAppView(undefined)).toBe(false);
    expect(isAppView("home")).toBe(false);
    expect(isAppView({})).toBe(false);
    expect(isAppView({ builtin: "settings" })).toBe(false);
    expect(isAppView({ spaceName: "" })).toBe(false);
    expect(isAppView({ spaceDid: "not-a-did" })).toBe(false);
    // A piece is addressed one way or the other, never both.
    expect(
      isAppView({ spaceName: "space", pieceId: "fid1:abc", pieceSlug: "d" }),
    )
      .toBe(false);
  });

  it("rejects a member with no collection to belong to", () => {
    expect(isAppView({ spaceName: "space", pieceMember: "42" })).toBe(false);
    expect(
      isAppView({ spaceName: "space", pieceId: "fid1:abc", pieceMember: "42" }),
    ).toBe(false);
    expect(
      isAppView({ spaceName: "space", pieceSlug: "top", pieceMember: "42" }),
    ).toBe(true);
    // The shell carries a key through whether or not the view has a value
    // for it, so a member key holding nothing reaches this the same way.
    expect(
      isAppView({ spaceName: "space", pieceMember: undefined }),
    ).toBe(true);
  });

  it("compares two views by their contents", () => {
    const view = { spaceName: "space", pieceSlug: "demo" } as const;
    expect(isAppViewEqual(view, view)).toBe(true);
    expect(isAppViewEqual(view, { spaceName: "space", pieceSlug: "demo" }))
      .toBe(true);
    expect(isAppViewEqual(view, { spaceName: "space", pieceSlug: "other" }))
      .toBe(false);
    expect(isAppViewEqual(view, { builtin: "home" })).toBe(false);
  });

  it("compares two views holding the same fields in a different order", () => {
    // A route parsed from a URL names the space first; a navigation mapped
    // from a space DID back onto the current space name rebuilds the view
    // with the piece first.
    expect(isAppViewEqual(
      { spaceName: "space", pieceId: "fid1:abc" },
      { pieceId: "fid1:abc", spaceName: "space" },
    )).toBe(true);
    expect(isAppViewEqual(
      { spaceName: "space", pieceId: "fid1:abc" },
      { pieceId: "fid1:abc", spaceName: "other" },
    )).toBe(false);
    expect(isAppViewEqual(
      { spaceName: "space", pieceId: "fid1:abc" },
      { spaceName: "space" },
    )).toBe(false);
  });

  it("counts a field holding undefined as absent", () => {
    // The shell rebuilds a navigated view field by field, carrying a key
    // through whenever the view has it, so a key present with no value
    // reaches this comparison.
    expect(isAppViewEqual(
      { spaceName: "space", pieceId: undefined },
      { spaceName: "space" },
    )).toBe(true);
    expect(isAppViewEqual(
      { spaceName: "space", pieceId: undefined, mode: undefined },
      { spaceName: "space" },
    )).toBe(true);
    expect(isAppViewEqual(
      { spaceName: "space", pieceId: undefined },
      { spaceName: "space", pieceId: "fid1:abc" },
    )).toBe(false);
  });

  it("treats slug piece routes as non-default pattern views", () => {
    expect(isViewingDefaultPatternView({ spaceName: "space" })).toBe(true);
    expect(
      isViewingDefaultPatternView({ spaceName: "space", pieceId: "fid1:abc" }),
    ).toBe(false);
    expect(
      isViewingDefaultPatternView({ spaceName: "space", pieceSlug: "demo" }),
    ).toBe(false);
  });
});
