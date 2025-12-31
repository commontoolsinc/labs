# CT Protocol: Verifiable State Update & Provenance

**Status:** Draft

This spec was originally a single document and is now split into smaller files
for easier review and iteration.

## Document Map

- `docs/specs/verifiable-execution/01-foundations.md` (Sections 1–4)
- `docs/specs/verifiable-execution/02-commit-model.md` (Section 5)
- `docs/specs/verifiable-execution/03-capabilities-api.md` (Section 6)
- `docs/specs/verifiable-execution/04-receipts.md` (Section 7)
- `docs/specs/verifiable-execution/05-log-and-authorization.md` (Sections 8–9)
- `docs/specs/verifiable-execution/06-cfc-and-trust.md` (Sections 10–12)
- `docs/specs/verifiable-execution/07-extensions-and-appendices.md` (Sections 13–17, Appendices)

## Proposals (Editorial + Spec Clarifications)

These are improvements that make the spec easier to implement and verify without changing core design goals:

- Keep the Capabilities/API section aligned with `packages/memory/interface.ts` (endpoint names, selector shapes, and error semantics).
- Clarify that labels are schema-derived and may vary by JSON path (`docs/specs/json_schema.md#ifc`), while `Labels.classification` remains a coarse/legacy summary.
- Make “Receipt” vs “Commit” terminology explicit (current implementation centers on commit facts; richer receipts are described as future work).
- Specify a canonical form for “label maps” (path addressing, ordering/canonicalization, and what must be committed vs what can be derived from schemas).
- Tighten the conflict/compare-and-swap story (define “expected vs actual” precisely and what information a client can rely on when retrying).
- Specify signature and multi-signer receipt formats (including how signatures bind to code/policy/label commitments).
