# Patterns

End-user programs ("patterns") for the Common Fabric runtime, plus the component
catalog and the system patterns that ship with the product.

This README is intentionally just a signpost. The maintained references are:

- **[index.md](./index.md)** — the canonical pattern catalog: every pattern with
  a summary, data types, and keywords. Start with its **Status tiers** section,
  which says whether a given pattern is an _exemplar_ (imitate it), a _demo_
  (illustrates one capability; wiring may be intentionally verbose), a _fixture_
  (regression scaffolding; never imitate), or _legacy_ (do not copy).
- **[catalog/catalog.tsx](./catalog/catalog.tsx)** — the authoritative,
  type-checked UI component catalog; live usage in
  [catalog/stories/](./catalog/stories/). Narrative component docs live in
  [docs/common/components/COMPONENTS.md](../../docs/common/components/COMPONENTS.md).
- **[DEPRECATED_IDIOMS.md](./DEPRECATED_IDIOMS.md)** — API-level migrations (old
  idiom → current idiom).
- **[skills/pattern-dev](../../skills/pattern-dev/SKILL.md)** — the workflow
  guide for authoring patterns; broader pattern documentation is indexed from
  [docs/common/README.md](../../docs/common/README.md).

The `deprecated/` subdirectory is defunct — ignore it entirely.

A previous version of this file was a hand-maintained duplicate of the catalog;
it drifted badly. Add new catalog entries to `index.md` only (and give them a
status tier).
