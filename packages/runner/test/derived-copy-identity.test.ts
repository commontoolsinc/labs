import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  brandTrustedBuilderArtifact,
  brandTrustedPattern,
  getArtifactEntryRef,
  getGeneratedInternalCellPatternIdentity,
  isTrustedBuilderArtifact,
  isTrustedPattern,
  noteDerivedCopy,
  resolveOriginal,
  setArtifactEntryRef,
} from "../src/builder/pattern-metadata.ts";
import { getEffectiveGeneratedInternalCellPatternIdentity } from "../src/link-utils.ts";

/**
 * Derived-copy identity carry (PR B of
 * docs/history/specs/content-addressed-action-identity-implementation-plan.md).
 *
 * Copies of builder artifacts (build-time graph serialization, traversal,
 * binding) register `copy → original` in a module-level WeakMap via
 * `noteDerivedCopy` — replacing the `unsafe_originalPattern` symbol backref.
 * Trust propagates eagerly (brands always precede copies: builders brand at
 * creation time); entry refs resolve lazily through `resolveOriginal` because
 * refs are indexed only post-evaluation, AFTER build-time copies were made.
 */

const patternShape = () => ({
  argumentSchema: { type: "object" as const },
  resultSchema: { type: "object" as const },
  nodes: [],
  result: {},
});

const patternWithInternals = () => ({
  ...patternShape(),
  derivedInternalCells: [
    { partialCause: { $generated: 0 } },
    { partialCause: "named-state" },
  ],
});

describe("noteDerivedCopy trust carry", () => {
  it("a copy of a branded pattern is trusted; a forged object is not", () => {
    const original = brandTrustedPattern(patternShape());
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    expect(isTrustedPattern(copy)).toBe(true);

    // Forged values gain nothing: no own property can grant trust...
    const forged = {
      ...patternShape(),
      ["unsafe_originalPattern"]: original,
    };
    expect(isTrustedPattern(forged)).toBe(false);
    // ...and a forged value never reaches noteDerivedCopy with a trusted
    // original, so it stays untrusted.
    expect(isTrustedBuilderArtifact({ forged: true })).toBe(false);
  });

  it("copies of copies resolve to the root original", () => {
    const original = brandTrustedBuilderArtifact({ kind: "factory" });
    const copy1 = { kind: "copy1" };
    noteDerivedCopy(copy1, original);
    const copy2 = { kind: "copy2" };
    noteDerivedCopy(copy2, copy1);
    expect(resolveOriginal(copy2)).toBe(original);
    expect(isTrustedBuilderArtifact(copy2)).toBe(true);
  });

  it("an untrusted original confers nothing", () => {
    const original = patternShape();
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    expect(isTrustedPattern(copy)).toBe(false);
  });
});

describe("entry-ref resolution through copies", () => {
  it("ignores non-object artifacts", () => {
    const ref = { identity: "ignored", symbol: "default" };
    setArtifactEntryRef("not-an-artifact", ref);
    expect(getArtifactEntryRef("not-an-artifact")).toBeUndefined();
    expect(resolveOriginal("not-an-artifact")).toBe("not-an-artifact");
  });

  it("resolves a ref registered BEFORE the copy (eager)", () => {
    const original = brandTrustedPattern(patternShape());
    setArtifactEntryRef(original, { identity: "id-eager", symbol: "default" });
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    expect(getArtifactEntryRef(copy)).toEqual({
      identity: "id-eager",
      symbol: "default",
    });
  });

  it("resolves a ref registered AFTER the copy (lazy — the build-time order)", () => {
    // Build-time copies are made during module evaluation; refs are indexed
    // post-evaluation by registerEvaluatedModules. The lookup must therefore
    // walk to the original at resolution time.
    const original = brandTrustedPattern(patternShape());
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    setArtifactEntryRef(original, { identity: "id-lazy", symbol: "op" });
    expect(getArtifactEntryRef(copy)).toEqual({
      identity: "id-lazy",
      symbol: "op",
    });
  });

  it("first-write-wins for a value's ref", () => {
    const original = brandTrustedPattern(patternShape());
    setArtifactEntryRef(original, { identity: "first", symbol: "a" });
    setArtifactEntryRef(original, { identity: "second", symbol: "b" });
    expect(getArtifactEntryRef(original)).toEqual({
      identity: "first",
      symbol: "a",
    });
  });
});

describe("generated internal-cell pattern identity", () => {
  it("associates only generated descriptors with the artifact ref", () => {
    const pattern = brandTrustedPattern(patternWithInternals());
    const ref = { identity: "pattern-v1", symbol: "default" };
    setArtifactEntryRef(pattern, ref);

    expect(
      getGeneratedInternalCellPatternIdentity(
        pattern.derivedInternalCells[0],
      ),
    ).toEqual(ref);
    expect(
      getGeneratedInternalCellPatternIdentity(
        pattern.derivedInternalCells[1],
      ),
    ).toBeUndefined();
  });

  it("associates a pre-index copy lazily when its ref is resolved", () => {
    const original = brandTrustedPattern(patternWithInternals());
    const copy = patternWithInternals();
    noteDerivedCopy(copy, original);
    const ref = { identity: "pattern-v2", symbol: "op" };
    setArtifactEntryRef(original, ref);

    expect(getArtifactEntryRef(copy)).toEqual(ref);
    expect(
      getGeneratedInternalCellPatternIdentity(copy.derivedInternalCells[0]),
    ).toEqual(ref);
  });

  it("uses the versioned identity when the current manifest is absent", () => {
    const pattern = brandTrustedPattern(patternWithInternals());
    const ref = { identity: "pattern-v3", symbol: "default" };
    setArtifactEntryRef(pattern, ref);

    const resultCell = {
      getMetaRaw(field: string) {
        return field === "patternIdentity" ? ref : undefined;
      },
    } as unknown as Parameters<
      typeof getEffectiveGeneratedInternalCellPatternIdentity
    >[0];

    expect(
      getEffectiveGeneratedInternalCellPatternIdentity(
        resultCell,
        pattern.derivedInternalCells[0],
      ),
    ).toEqual(ref);
  });
});
