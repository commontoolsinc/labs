# cf-harness Roadmap

Status: live, non-normative\
Last reviewed: 2026-07-22

This document lists remaining work. Shipped milestones belong in
[CURRENT_STATE.md](CURRENT_STATE.md), tests, and history rather than in a
permanently growing implementation plan.

## 1. Complete the CFC transport boundary

- Carry trusted observation metadata from `runsc-cfc`/runner mediation through
  every tool path used by Loom and Pattern Factory.
- Exercise `enforce-explicit` in product adapter tests without losing ordinary
  tool observations.
- Remove the product `observe` bridges only after those suites prove the full
  path and retained run evidence explains every release/denial.
- Keep prompt-slot evidence, model-context influence, invocation inputs, and
  side-effect authorization distinct.

## 2. Make dependency readiness contractual

- Add a preflight surface for Docker daemon, selected runtime, sandbox image,
  model gateway, mounts, Browser Access lease, and trusted CFC sidecar paths.
- Let product adapters reject a run before its first model turn when a required
  dependency is unavailable.
- Keep capability discovery deterministic and side-effect free; report health
  separately rather than overloading capability presence.

## 3. Stabilize the interactive protocol

- Version and document the NDJSON request/response/event schemas as a supported
  compatibility surface.
- Finish product-level browser support and define any allowed turn concurrency.
- Expand crash/reconnect and cancellation integration tests before making the
  Loom adapter generally available.

## 4. Tighten delegation and artifacts

- Replace parent/model-facing raw artifact paths with opaque handles and an
  explicit release/readback mechanism.
- Decide whether parallel children are a product requirement; if so, specify
  scheduling, budget, cancellation, event ordering, and context isolation before
  implementing them.
- Extend resume only where external side-effect replay semantics can be made
  explicit and testable.

## 5. Evolve skills only from concrete needs

- Keep explicit caller preload and profile-scoped child skills as the stable
  path.
- Add model-driven `load_skill` activation only when a product needs it and the
  catalog, policy, digest, resume, and subagent semantics are agreed.
- Do not add remote/global skill installation before provenance and trust policy
  are explicit.

## Exit discipline

When a roadmap item ships, update the current reference and conformance profile,
add test evidence, and remove it from this file. If a proposed direction is
abandoned or superseded, preserve the decision as a historical record instead of
leaving a stale “next step” in live documentation.
