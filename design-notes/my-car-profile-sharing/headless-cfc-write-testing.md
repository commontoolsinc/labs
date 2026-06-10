# Sketch for @seefeldb: testing enforced owner-protected writes headlessly

**TL;DR.** There's no way to test an _enforced_ owner-protected write whose
`writeAuthorizedBy` is a **function identity** (`typeof someHandler`) in a
headless runner test — the write aborts because the handler never resolves to a
_verified binding_ identity. This blocks a faithful **CT-1658 regression test**
(and headless coverage of every owner-protected pattern field). This is a small,
well-scoped runtime/test-harness change in your verified-source area; sketch +
options below, please pick a shape.

## Why it matters here

CT-1658 (owner-protected array writes failing across the source→by-identity
reload boundary) appears **fixed by construction** by your #3859: the
`writeAuthorizedBy` `bundleId` is
`harness.getVerifiedBundleId(verifiedLoadId) ?? verifiedLoadId`
(`cfc/implementation-identity.ts:102`), and #3859 makes the `implementationRef`/
`fn.src` it derives from identical across source-based and by-identity loads —
so the `cfc/schema-merge.ts:94` `deepEqual` that threw
`writeAuthorizedBy must remain stable` now passes. We'd like a **regression
test** that pins this. But we can't write one headlessly today (details below),
so it's currently only verifiable in the browser.

## The exact gap

For a function-identity `writeAuthorizedBy` (what
`OwnerProtectedProfileWrite<T,
typeof addClaim>` lowers to),
`writeAuthorizedByReason` (`cfc/prepare.ts:271-326`) requires the acting
`implementationIdentity` to be:

```ts
// prepare.ts:313
if (!identity || identity.kind !== "verified" || !identity.bindingPath) {
  return `writeAuthorizedBy requires a trusted verified binding identity at /${path…}`;
}
```

A running handler _does_ set its policy-facing identity (`runner.ts:2894`
`tx.setCfcImplementationIdentity(policyFacingIdentity)`), but
`resolvePolicyFacingImplementationIdentity`
(`cfc/implementation-identity.ts:63-117`) only yields `kind:"verified"` **with a
`bindingPath`** when the **harness** answers all of:

- `harness.getVerifiedFunctionInLoad(verifiedLoadId, implementationRef) === implementation`
- `harness.isVerifiedSourceInLoad(verifiedLoadId, sourceLocation.source) === true`
- `harness.getVerifiedBindingMetadata(implementationRef)?.bindingPath` is
  present

In a bare `compilePattern(...)` test runtime (even under `esmModuleLoader`), at
least one of these isn't populated, so the result is `kind:"unsupported"` (or
verified without `bindingPath`) → the owner-protected write aborts. The abort is
also **swallowed** — it surfaces only as `StorageTransactionAborted`, with no
`writeAuthorizedByReason` string, even at `LOG_LEVEL=debug` (see "Option C").

Contrast: `profile-owner-cfc.test.ts` can test owner-protected writes only
because it uses a **builtin-id** `writeAuthorizedBy` (`"system.profile-home"`) +
a _direct_ write with a manual ceremony
(`setCfcImplementationIdentity({kind:"builtin",…})` +
`recordCfcWritePolicyInput`). That path can't carry the **load-dependent
function bundleId** CT-1658 is about, so it can't reproduce CT-1658.
`trustPattern` (`unsafeTrustPattern`) does **not** close the gap — it grants
host trust, not a verified-binding identity.

(For owner-protected fields that instead require a
`uiContract`/`requiredEventIntegrity`, the faithful seam already exists:
`markRendererTrustedEvent` (`cfc/mod.ts:69`, what
`html/worker/reconciler.ts:249` calls) + the event's `provenance`. MyCar's
`selfClaims` has no `uiContract`, so that path doesn't apply — this ask is
specifically the function-identity `writeAuthorizedBy` case.)

## Proposed shapes (please pick)

- **A — test-only verified-binding registration (recommended).** A
  `runtime.unsafeRegisterVerifiedBinding(compiled)` (or fold into
  `trustPattern`) that seeds the harness's verified maps
  (`getVerifiedFunctionInLoad` / `isVerifiedSourceInLoad` /
  `getVerifiedBindingMetadata`+`bindingPath`) for a compiled pattern's handlers,
  gated behind the existing `unsafeHostTrust`. Produces a _real_
  `kind:"verified"` identity — faithful shape, test-only entry, smallest
  surface.
- **B — populate verified-binding metadata in the test compile path.** If
  `compilePattern` under `esmModuleLoader` already resolves `fn.src` (your
  verified-source work, #8c66ec989) but doesn't register binding metadata,
  wiring that in would make enforced owner-protected handler writes "just work"
  headlessly with no extra API. More correct, but touches the compile/verify
  path.
- **C — surface `writeAuthorizedByReason` (complementary).** Independent of A/B:
  make the swallowed reason observable to test authors (it currently vanishes
  into `StorageTransactionAborted`). Small, and it's what cost us the most time
  here.

## First consumer (the regression test we'd add once unblocked)

Two runtimes sharing storage (mirrors `by-identity-handler-exec.test.ts`): rt1
source-based compiles + runs an owner-protected-array pattern and persists; rt2
resumes **by identity** and writes the field via its bound handler under default
`enforce-explicit`. Asserts the write lands (no
`writeAuthorizedBy must remain stable`). With #3859 reverted it should throw;
with #3859 it passes — pinning CT-1658.

@seefeldb — which of A/B/C do you want, and do you want to own it or have us
prototype your preferred shape?
