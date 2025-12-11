# Pattern Library Rationalization

**Status:** In Progress
**Tracking tag:** `@reviewed 2025-12-10 docs-rationalization`

---

## Goal

Rationalize the fragmented pattern library and documentation to enable Claude-driven pattern development with minimal human oversight.

---

## Completed

### Documentation Validation
- All 15 `docs/common/` files validated against codebase
- Fixed stale references, incorrect terminology, outdated examples
- Standardized: `recipe`→`pattern`, `derive`→`computed`, `llm()`→`generateText()`/`generateObject()`
- All docs tagged with `@reviewed 2025-12-10 docs-rationalization`

### Pattern-Dev Skill
- Fixed stale doc references (removed RECIPES.md, HANDLERS.md)
- Updated to correct doc structure
- Added community-patterns references

### Handler Rules (from blessed docs)
- Added to DEBUGGING.md:
  - Never use await in handlers (use fetchData instead)

### Working Examples
- Created `packages/patterns/gpa-stats-source.tsx` and `gpa-stats-reader.tsx`
- Updated CHARM_LINKING.md to reference actual files (CI-checked)
- Fixed `packages/patterns/favorites-manager.tsx` to match FAVORITES.md

---

## Remaining Work

### Phase 1: Upstream Blessed Knowledge

From `community-patterns/community-docs/blessed/`:

| Topic | Target Doc | Priority |
|-------|------------|----------|
| Idempotent side effects in computed/lift | CELLS_AND_REACTIVITY.md | HIGH |
| ifElse executes BOTH branches | PATTERNS.md | HIGH |
| Cell.equals() vs manual IDs (don't use IDs) | CELLS_AND_REACTIVITY.md | MEDIUM |
| Cross-charm Stream invocation via wish() | CHARM_LINKING.md | MEDIUM |
| ct.render forces charm execution | CHARM_LINKING.md | MEDIUM |

### Phase 2: Superstition Validation

Review `community-patterns/community-docs/superstitions/` (~60 observations):
- Validate against ground truth
- Promote valid ones to folk_wisdom or official docs
- Mark/remove incorrect ones

### Phase 3: Pattern Consolidation (Future)

| Location | Count | Action |
|----------|-------|--------|
| `labs/packages/patterns/` | 56 | GOLD STANDARD - maintain |
| `labs/recipes/` | 30 | LEGACY - document status |
| `recipes/` repo | 33 | Evaluate, migrate valuable patterns |
| `community-patterns/` | 66+ | Upstream valuable patterns |

---

## Key Resources

### Canonical Locations
- **Patterns:** `labs/packages/patterns/`
- **Official Docs:** `labs/docs/common/`
- **Skills:** `labs/.claude/skills/pattern-dev/`, `labs/.claude/skills/ct/`

### Community Knowledge
- **Blessed (author-approved):** `community-patterns/community-docs/blessed/`
- **Folk Wisdom (validated):** `community-patterns/community-docs/folk_wisdom/`
- **Superstitions (unvalidated):** `community-patterns/community-docs/superstitions/`

---

## Finding Reviewed Files

```bash
# All reviewed docs
grep -r "@reviewed.*docs-rationalization" docs/ packages/ .claude/

# Unreviewed docs
for f in docs/common/*.md; do
  grep -q "@reviewed" "$f" || echo "$f"
done
```

---

## Updates Needed in Blessed Docs

These items in `community-patterns/community-docs/blessed/` were found to be outdated or incorrect:

| File | Topic | Issue |
|------|-------|-------|
| `handlers.md` | "Define handlers outside pattern function" | **OUTDATED** - The closures transformer now handles this correctly. Tested and confirmed handlers inside patterns work fine. |
