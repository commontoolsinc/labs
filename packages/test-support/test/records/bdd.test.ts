/**
 * The `describe` and `it` this repository's import map resolves to.
 *
 * What matters is that the wrapper is transparent: every way the real
 * ones can be called still registers, and a call the wrapper does not
 * model reaches the real function untouched rather than being dropped.
 * The shapes below are registered for real, which is the assertion — a
 * shape the wrapper mishandled would fail to register, or would register
 * a test with no body, and Deno would refuse the module.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { bodyOf, nameOf, wrapDescribe, wrapIt } from "../../src/records/bdd.ts";

describe("bdd", () => {
  describe("the shapes a suite can be declared in", () => {
    // Nested by name and body, which is the ordinary form and the one
    // the chain tracking is built around.

    it("registers a leaf given a name and a body", () => {
      expect(true).toBe(true);
    });

    it({
      name: "registers a leaf given one whole definition",
      fn: () => {
        expect(true).toBe(true);
      },
    });

    it("registers a leaf given a name, options and a body", {
      sanitizeOps: true,
    }, () => {
      expect(true).toBe(true);
    });
  });

  describe({
    name: "a suite declared as one whole definition",
    fn: () => {
      it("still names its leaves by the whole chain", () => {
        expect(true).toBe(true);
      });
    },
  });

  describe("the entry points hanging off each of them", () => {
    it.ignore("is registered as ignored rather than dropped", () => {
      throw new Error("an ignored leaf does not run");
    });

    // `describe.skip` is `describe.ignore` under another name; a suite
    // registered through either still registers, and its leaves are
    // reported as skipped rather than vanishing.
    describe.ignore("a suite registered as ignored", () => {
      it("does not run", () => {
        throw new Error("an ignored suite's leaves do not run");
      });
    });
  });
});

describe("reading the shape of a bdd call", () => {
  const body = () => {};

  it("takes the name from a string, an options object, or a function", () => {
    expect(nameOf(["a name", body])).toBe("a name");
    expect(nameOf([{ name: "from options" }, body])).toBe("from options");
    expect(nameOf([function named() {}])).toBe("named");
    // An anonymous body names nothing, and a call this cannot name goes
    // to the real function untouched rather than being dropped.
    expect(nameOf([{}, () => {}])).toBeUndefined();
    expect(nameOf([])).toBeUndefined();
  });

  it("finds the body whether it is an argument or a field", () => {
    expect(bodyOf(["a name", body])).toEqual({ index: 1, body });
    // A definition carrying its own body is reported at index -1,
    // because what has to be replaced is the field rather than the
    // argument.
    expect(bodyOf([{ name: "x", fn: body }])).toEqual({ index: -1, body });
    expect(bodyOf(["a name"])).toBeUndefined();
  });
});

describe("what the wrappers do once a capture is installed", () => {
  /** A capture that skips what a case names, and says what it was asked. */
  function capturing(skips: readonly string[] = []) {
    const asked: string[] = [];
    const capture = () => ({
      names: new Map<string, string>(),
      skipped: (_file: string | undefined, name: string) => {
        asked.push(name);
        return skips.includes(name);
      },
      flush: () => {},
    });
    return Object.assign(capture, { asked });
  }

  it("passes a call it cannot read straight through", () => {
    // An unfamiliar overload still runs and still reports its own
    // error, rather than being dropped by a wrapper that did not
    // recognize it.
    const seen: unknown[][] = [];
    const through = (...args: unknown[]) => seen.push(args);
    wrapDescribe(through, capturing())("a name with no body");
    wrapIt(through, () => {}, capturing())({ no: "name" });
    expect(seen).toEqual([["a name with no body"], [{ no: "name" }]]);
  });

  it("encloses a leaf in the chain of a suite declared as one definition", () => {
    // The chain has to be pushed around the body wherever the body
    // sits, so a definition carrying its own `fn` has that field
    // replaced rather than an argument. What proves it is the name the
    // capture is asked about: the leaf's own name means the body ran
    // outside the chain, and the joined name means it ran inside.
    const inner = capturing();
    const through = (definition: { name: string; fn: () => void }) => {
      definition.fn();
    };
    const it_ = wrapIt(() => {}, () => {}, inner);
    wrapDescribe(through, capturing())({
      name: "outer",
      fn: () => it_("leaf", () => {}),
    });
    expect(inner.asked).toEqual(["outer > leaf"]);
  });

  it("names a leaf by itself where no suite encloses it", () => {
    const alone = capturing();
    wrapIt(() => {}, () => {}, alone)("bare leaf", () => {});
    expect(alone.asked).toEqual(["bare leaf"]);
  });

  it("registers a listed leaf as ignored rather than running it", () => {
    const ran: string[] = [];
    const ignored: string[] = [];
    const it_ = wrapIt(
      (name: string) => ran.push(name),
      (name: string) => ignored.push(name),
      capturing(["skipped leaf"]),
    );
    it_("kept leaf", () => {});
    it_("skipped leaf", () => {});
    expect(ran).toEqual(["kept leaf"]);
    // Listed rather than dropped, so it appears in the report as
    // skipped and the store learns it was deliberately not run.
    expect(ignored).toEqual(["skipped leaf"]);
  });
});
