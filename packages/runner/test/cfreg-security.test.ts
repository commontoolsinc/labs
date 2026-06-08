import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createHoistRegistrar,
  createRejectingRegistrar,
  type HoistRegistrationSink,
} from "../src/sandbox/module-record-compiler.ts";
import { verifyCompiledModuleBody } from "../src/sandbox/module-record-verifier.ts";
import {
  brandTrustedBuilderArtifact,
  isTrustedBuilderArtifact,
} from "../src/builder/pattern-metadata.ts";
import { unsafe_originalPattern } from "../src/builder/types.ts";

// Security invariants for the `__cfReg` content-addressed registration mechanism
// (CT-1623). The compiled module body is treated as UNTRUSTED; defenses live in
// four layers (verifier, registrar capability, per-value trust gate, content
// addressing). The adversarial *verifier* corpus lives in
// esm-verifier-adversarial.test.ts; this file pins the runtime layers.

const IMPORT = `const cf = require("commonfabric");`;

// The verifier reports whether a module has a VALID approved `__cfReg` call. The
// loader uses this to grant the real registrar only to approved modules (and a
// throwing one to the rest) — so this signal is load-bearing.
describe("verifyCompiledModuleBody reports hoist-registration approval", () => {
  it("is true for a module with an approved __cfReg call", () => {
    const body =
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n__cfReg({ __cfPattern_1 });`;
    expect(verifyCompiledModuleBody(body, "/main.tsx").hasHoistRegistration)
      .toBe(true);
  });

  it("is false for a module with no __cfReg call", () => {
    const body = `${IMPORT}\nexports.default = (0, cf.pattern)((s) => s);`;
    expect(verifyCompiledModuleBody(body, "/main.tsx").hasHoistRegistration)
      .toBe(false);
  });
});

// A module the verifier did NOT approve gets the rejecting registrar, so a
// `__cfReg` call the static check missed (e.g. smuggled inside an accepted
// expression) fails closed at runtime instead of registering attacker values.
describe("createRejectingRegistrar", () => {
  it("throws on any registration attempt", () => {
    const { register } = createRejectingRegistrar();
    expect(() => register({ __cfPattern_1: {} })).toThrow(
      /no verifier-approved registration/,
    );
  });

  it("has a no-op commit (nothing was staged)", () => {
    const { commit } = createRejectingRegistrar();
    expect(() => commit()).not.toThrow();
  });
});

// The load-bearing trust gate: only a genuine branded builder artifact may
// acquire a content-addressed ref. The verifier intentionally does NOT check the
// registered value's kind, so `indexArtifact`'s `isTrustedBuilderArtifact` is the
// single boundary that stops forgery — pin it hard.
describe("isTrustedBuilderArtifact rejects forged values", () => {
  it("rejects plain objects, functions, and frozen data", () => {
    expect(isTrustedBuilderArtifact({})).toBe(false);
    expect(isTrustedBuilderArtifact(() => {})).toBe(false);
    expect(isTrustedBuilderArtifact(Object.freeze({ a: 1 }))).toBe(false);
    expect(isTrustedBuilderArtifact(null)).toBe(false);
    expect(isTrustedBuilderArtifact(undefined)).toBe(false);
    expect(isTrustedBuilderArtifact(42)).toBe(false);
  });

  it("rejects a pattern-shaped object with no brand (forged __cf_data)", () => {
    const forged = Object.freeze({
      argumentSchema: true,
      resultSchema: true,
      nodes: [],
    });
    expect(isTrustedBuilderArtifact(forged)).toBe(false);
  });

  it("is not fooled by a STRING-keyed 'unsafe_originalPattern'", () => {
    // The trust chain follows the module-private SYMBOL `unsafe_originalPattern`,
    // which authored code cannot reference. A string property of the same name
    // is inert, so it cannot launder trust onto a forged object.
    const branded = brandTrustedBuilderArtifact({});
    const forged = { ["unsafe_originalPattern"]: branded };
    expect(isTrustedBuilderArtifact(forged)).toBe(false);
  });

  it("accepts a genuinely branded artifact (and copies linking to it)", () => {
    const artifact = brandTrustedBuilderArtifact({});
    expect(isTrustedBuilderArtifact(artifact)).toBe(true);
    // A derivation copy whose symbol chain reaches the branded original inherits
    // trust (this is the legitimate path the chain walk exists for).
    const copy = { [unsafe_originalPattern]: artifact };
    expect(isTrustedBuilderArtifact(copy)).toBe(true);
  });
});

// Defense-in-depth on the real registrar (run-once / closed-window /
// transactional) lives in cfreg-builder-identity.test.ts; here we only assert the
// rejecting variant, the trust gate, and the approval signal — the pieces the
// verifier-gating relies on.
describe("HoistRegistrationSink stays untouched on a rejected registration", () => {
  it("an approved registrar still stages+commits normally", () => {
    const sink: HoistRegistrationSink = new Map();
    const { register, commit } = createHoistRegistrar("id", sink);
    register({ __cfPattern_1: brandTrustedBuilderArtifact({}) });
    commit();
    expect(sink.get("id")?.has("__cfPattern_1")).toBe(true);
  });
});
