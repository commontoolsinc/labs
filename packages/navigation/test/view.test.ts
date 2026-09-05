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

  it("parses a space written with the reference's leading mark", () => {
    // `/@<space>/<collection>/<member>` is the reference the shell's header
    // hands out, so the shell reads back what it gives away. A name and a DID
    // both answer to the mark, and the mark reaches a space naming no piece
    // as well as one naming a member.
    expect(urlToAppView(new URL("http://common.test/@space/top/42"))).toEqual({
      spaceName: "space",
      pieceSlug: "top",
      pieceMember: "42",
    });
    expect(urlToAppView(new URL(`http://common.test/@${SPACE_DID}/top/42`)))
      .toEqual({ spaceDid: SPACE_DID, pieceSlug: "top", pieceMember: "42" });
    expect(urlToAppView(new URL("http://common.test/@space/demo"))).toEqual({
      spaceName: "space",
      pieceSlug: "demo",
    });
    expect(urlToAppView(new URL("http://common.test/@space"))).toEqual({
      spaceName: "space",
    });
    // Embed mode belongs to the route rather than to the space, so the two
    // prefixes compose.
    expect(urlToAppView(new URL("http://common.test/.embed/@space/top/42")))
      .toEqual({
        spaceName: "space",
        pieceSlug: "top",
        pieceMember: "42",
        mode: "embed",
      });
    // The mark is no part of the space, so a page URL built from the route
    // carries the space in its segments and nothing else.
    expect(
      appViewToUrlPath(
        urlToAppView(new URL("http://common.test/@space/top/42")),
      ),
    ).toBe("/space/top/42");
  });

  it("routes a mark naming no space to the home view", () => {
    // A segment that is nothing but the mark names no space, which is the
    // address a bare origin already carries.
    expect(urlToAppView(new URL("http://common.test/@"))).toEqual({
      builtin: "home",
    });
    expect(urlToAppView(new URL("http://common.test/.embed/@"))).toEqual({
      builtin: "home",
    });
  });

  it("decodes the space segment and no other", () => {
    // Reading the mark means reading through an escape of it, so `%40space`
    // reaches the space `@space` reaches — and the decoding stops there.
    // Every other segment is carried in the spelling the URL wrote, because
    // holding one to a grammar is the resolver's question and not this one's.
    // One URL states both halves: the space loses its escape, the member
    // keeps its own.
    expect(urlToAppView(new URL("http://common.test/%40space/top/4%32")))
      .toEqual({
        spaceName: "space",
        pieceSlug: "top",
        pieceMember: "4%32",
      });
    // An unmarked space is carried whole, so the two differ only by the mark.
    expect(urlToAppView(new URL("http://common.test/%40space%20x/demo")))
      .toEqual({ spaceName: "space x", pieceSlug: "demo" });
    expect(urlToAppView(new URL("http://common.test/space%20x/demo")))
      .toEqual({ spaceName: "space%20x", pieceSlug: "demo" });
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

  it("rejects a member that is no single URL segment", () => {
    // An empty member serializes to the collection's own URL, so a view
    // holding one addresses the piece that holds the collection while
    // claiming to address a member of it.
    expect(
      isAppView({ spaceName: "space", pieceSlug: "top", pieceMember: "" }),
    ).toBe(false);
    // Naming no member at all is how a view addresses the collection, and it
    // stays valid: the field is optional, not empty-able.
    expect(isAppView({ spaceName: "space", pieceSlug: "top" })).toBe(true);
    // A separator would round-trip as two segments, the second of them read
    // as no part of the address.
    expect(
      isAppView({ spaceName: "space", pieceSlug: "top", pieceMember: "4/2" }),
    ).toBe(false);
    // `..` resolves away before a parser ever sees it as a segment.
    expect(
      isAppView({ spaceName: "space", pieceSlug: "top", pieceMember: ".." }),
    ).toBe(false);
  });

  it("reads a member out of a URL without holding it to that grammar", () => {
    // Reading segments apart from resolving them is what keeps the parse
    // pure, so a member no collection could have named still parses and is
    // refused by name where the reference resolves. This is the same
    // permissiveness the parse already gives a piece id it never validates.
    expect(urlToAppView(new URL("http://common.test/space/top/NOPE"))).toEqual({
      spaceName: "space",
      pieceSlug: "top",
      pieceMember: "NOPE",
    });
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
