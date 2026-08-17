import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  canonicalizePreparedDigestInput,
  type CfcDereferenceTrace,
  preparedDigestFor,
  type PreparedDigestInput,
} from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase("runner-cfc-canonical");

describe("canonical", () => {
  const address = (id: string, ...path: string[]) => ({
    space: signer.did(),
    scope: "space" as const,
    id: `of:${id}`,
    path,
  });

  const trace = (
    source: CfcDereferenceTrace["source"],
    target: CfcDereferenceTrace["target"],
    kind: CfcDereferenceTrace["kind"] = "value",
  ): CfcDereferenceTrace => ({ source, target, kind });

  const baseInput = (
    overrides: Partial<PreparedDigestInput>,
  ): PreparedDigestInput => ({
    consumedReads: [],
    attemptedWrites: [],
    writes: [],
    writeAttemptLog: [],
    dereferenceTraces: [],
    triggerReads: [],
    writePolicyInputs: [],
    implementationIdentity: undefined,
    trustSnapshot: undefined,
    ...overrides,
  });

  const digestOf = (traces: CfcDereferenceTrace[]) =>
    preparedDigestFor(baseInput({ dereferenceTraces: traces }));

  describe("dereference traces in the prepared digest", () => {
    const hop = trace(address("board"), address("row"));

    it("digests a repeated dereference the same as a single one", () => {
      // The digest binds WHICH dereferences ran, not how many times a link
      // was read: a quadratic scan over a list resolves each element's link
      // once per pass, and those passes observe nothing the first did not.
      expect(digestOf([hop, hop, hop])).toBe(digestOf([hop]));
    });

    it("digests a structurally equal repeat the same as a single one", () => {
      // Equality is by content, not object identity — the traces a walk
      // records are freshly built per hop.
      const equal = trace(address("board"), address("row"));
      expect(digestOf([hop, equal])).toBe(digestOf([hop]));
    });

    it("collapses a repeat that differs only by a leading `value` element", () => {
      // Dedupe runs after canonicalization, which strips the leading `value`
      // element. Before it, these two are unequal records.
      const raw = trace(
        address("board", "value", "items"),
        address("row", "value", "cells"),
      );
      const canonical = trace(
        address("board", "items"),
        address("row", "cells"),
      );
      expect(digestOf([raw, canonical])).toBe(digestOf([canonical]));
    });

    it("distinguishes two different dereferences from one repeated twice", () => {
      // The guard against a dedupe that collapses too much: two distinct
      // hops must not digest as one hop read twice.
      const other = trace(address("board"), address("other-row"));
      expect(digestOf([hop, other])).not.toBe(digestOf([hop, hop]));
    });

    it("distinguishes traces that differ only in their source", () => {
      const elsewhere = trace(address("other-board"), address("row"));
      expect(digestOf([hop, elsewhere])).not.toBe(digestOf([hop]));
    });

    it("distinguishes traces that differ only in their kind", () => {
      const redirect = trace(
        address("board"),
        address("row"),
        "write-redirect",
      );
      expect(digestOf([hop, redirect])).not.toBe(digestOf([hop]));
    });

    it("distinguishes traces that differ only in their target path", () => {
      const deeper = trace(address("board"), address("row", "cells"));
      expect(digestOf([hop, deeper])).not.toBe(digestOf([hop]));
    });

    it("digests the same set regardless of the order it is presented in", () => {
      const other = trace(address("board"), address("other-row"));
      expect(digestOf([hop, other])).toBe(digestOf([other, hop]));
    });

    it("canonicalizes interleaved repeats to one entry per distinct trace", () => {
      const other = trace(address("board"), address("other-row"));
      const canonical = canonicalizePreparedDigestInput(
        baseInput({ dereferenceTraces: [hop, other, hop, other, hop] }),
      );
      expect(canonical.dereferenceTraces).toHaveLength(2);
    });
  });
});
