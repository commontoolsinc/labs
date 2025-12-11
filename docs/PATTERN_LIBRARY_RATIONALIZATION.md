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

### Documentation Tone Cleanup (2025-12-11)
- Reviewed all docs/common/ files for excessive severity markers
- Removed "⚠️ CRITICAL", excessive "IMPORTANT", "Critical:" markers
- Softened "Rule:" statements to friendlier guidelines
- Goal: ~1-2 critical items per doc max, everything else normal weight

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

| Topic | Target Doc | Priority | Status |
|-------|------------|----------|--------|
| Idempotent side effects in computed/lift | CELLS_AND_REACTIVITY.md | HIGH | TODO |
| ifElse executes BOTH branches | PATTERNS.md | HIGH | TODO |
| Cell.equals() vs manual IDs (don't use IDs) | CELLS_AND_REACTIVITY.md | MEDIUM | **BLOCKED** - see alias bug below |
| Cross-charm Stream invocation via wish() | CHARM_LINKING.md | MEDIUM | **DONE** (2025-12-11) |
| ct.render forces charm execution | CHARM_LINKING.md | MEDIUM | **DONE** (2025-12-11) |

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

### Canonical Locations (this repo: `labs/`)
- **Patterns:** `packages/patterns/`
- **Official Docs:** `docs/common/`
- **Skills:** `.claude/skills/pattern-dev/`, `.claude/skills/ct/`

### Community Knowledge (peer repo: `community-patterns/`)
- **Blessed (author-approved):** `community-docs/blessed/`
- **Folk Wisdom (validated):** `community-docs/folk_wisdom/`
- **Superstitions (unvalidated):** `community-docs/superstitions/`

**Note:** `community-patterns` is a sibling repo at `../community-patterns/` relative to `labs/`.

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

## Documentation Gaps Found

| Topic | Issue | Target Doc |
|-------|-------|------------|
| Wish tags must be in JSDoc on Output type | Not clearly documented - tags like `#mytag` must appear in a JSDoc comment on the Output interface/type, not in file-level comments | CHARM_LINKING.md or new WISH.md |
| Wish searches favorites, not all charms | `wish({ query: "#tag" })` searches **favorites list**, not all charms in the space. Charm must be favorited first to be discoverable. | CHARM_LINKING.md or FAVORITES.md |
| Cross-charm stream invocation mechanism | Streams from wished charms come as Cells wrapping `{ $stream: true }` marker. To invoke: call `.send(eventData)` on the Cell itself. Event must be object (runtime calls `preventDefault`), can have data properties, NO functions. | CHARM_LINKING.md |

---

## Updates Needed in Blessed Docs

These items in `community-patterns/community-docs/blessed/` were found to be outdated or incorrect:

| File | Topic | Issue |
|------|-------|-------|
| `handlers.md` | "Define handlers outside pattern function" | **OUTDATED** - The closures transformer now handles this correctly. Tested and confirmed handlers inside patterns work fine. |
| `cross-charm.md` | "Framework unwraps opaque stream into callable one" | **MISLEADING** - The blessed doc claims declaring `Stream<T>` in handler signature causes framework to "unwrap" the opaque stream. This is incorrect. The stream stays as a Cell; it works because Cell has `.send()` method that dispatches when contents have `$stream` marker. The code example works but the explanation of WHY it works is wrong. |
| `cross-charm.md` | Missing prerequisites for wish() | **INCOMPLETE** - Doc doesn't mention: (1) tags must be in JSDoc on Output type, (2) wish searches favorites only - charm must be favorited first, (3) event must be object (not undefined), no functions in event data. |

---

## Blessed Claims Verification Results

Manual testing of claims from `community-patterns/community-docs/blessed/`:

| Claim | Source | Result | Notes |
|-------|--------|--------|-------|
| "Never use await in handlers" | handlers.md | **VERIFIED** | await blocks UI; fetchData pattern keeps UI responsive. Test: `packages/patterns/blessed-verification/test-await-in-handler.tsx` |
| "Idempotent side effects in computed" | reactivity.md | **VERIFIED** | Non-idempotent side effects cause thrashing (hit 101 iteration limit). Test: `packages/patterns/blessed-verification/test-idempotent-side-effects.tsx` |
| "ifElse executes BOTH branches" | reactivity.md | **VERIFIED** | Both branch computeds run on every condition change, even the hidden one. Test: `packages/patterns/blessed-verification/test-ifelse-both-branches.tsx` |
| "Cell.equals() vs manual IDs" | reactivity.md | **BLOCKED** | (1) Closure bug in `.map()` callbacks still exists. (2) Workaround attempt uncovered **alias bug** - see below. Repros: `packages/patterns/repro-mapwithpattern-cell-closure.tsx`, `packages/patterns/blessed-verification/minimal-alias-bug.tsx` |
| Cross-charm Stream via wish() | cross-charm.md | **VERIFIED WITH CORRECTIONS** | Streams ARE invocable via `.send({})` on the Cell. Blessed doc's "auto-unwrap" explanation is wrong - no unwrapping happens. See `docs/BLESSED_VERIFICATION_NOTES.md`. Test: `packages/patterns/blessed-verification/test-cross-charm-*.tsx` |
| ct.render forces charm execution | cross-charm.md | **VERIFIED** | Wished charms only execute when rendered with `<ct-render $cell={...} />`. Test: `packages/patterns/blessed-verification/test-cross-charm-*.tsx` |

---

## Questions for Follow-up (Ask Manager)

### Idempotency Footgun

During testing of the idempotent side effects claim, we discovered a potential footgun:

**Issue:** Non-idempotent side effects in `computed()` can cause the scheduler to thrash until it hits the 101-iteration safety limit. This happens silently - no warning, just stops executing.

**Questions:**
1. Is there a way to detect/warn about non-idempotent side effects at compile time or with better runtime errors?
2. Should the 101-iteration limit produce a more descriptive error message pointing to the likely cause?
3. Is there documentation about what "idempotent" means in this context that we should reference?
4. Should we add a lint rule or transformer check for common non-idempotent patterns (like `array.push()` or `set([...arr, item])` in computed)?

---

## Follow-up Investigations (Not Yet Undertaken)

### 1. Array Element Alias Bug (NEW - 2025-12-11)

**Issue:** When you call `cell.set(array.get()[index])`, the runtime sees a `toCell` symbol on the array element and creates a **bidirectional alias** instead of copying the data. Future `.set()` calls on that cell write through to the original array element, causing data corruption.

**Repro:** `packages/patterns/blessed-verification/minimal-alias-bug.tsx`

**Steps to reproduce:**
1. Add 3 items to array (A, B, C)
2. `selectedItem.set(items.get()[0])` - selects A, creates alias
3. `selectedItem.set(items.get()[1])` - writes B's data INTO items[0]!
4. Array is now [B, B, C] instead of [A, B, C]

**Root cause hypothesis:** `validateAndTransform()` in schema.ts adds a `toCell` symbol to objects returned from `.get()`. When `.set()` sees this symbol via `isCellResultForDereferencing()`, it creates a link instead of copying. The link is bidirectional - subsequent writes go through it.

**Impact:** This blocks the "Cell.equals() vs manual IDs" pattern - any attempt to set `selectedItem` to an array element causes corruption.

**To investigate:**
- Should `.set()` copy data instead of creating alias when value has `toCell` symbol?
- Is there an explicit API for "copy" vs "alias" behavior?
- Is this intentional behavior that needs documentation?

### 2. Inline Handler asOpaque Bug

**Issue:** Inline arrow functions used as onClick handlers that capture pattern inputs get `asOpaque: true` instead of `asCell: true` in the transformed schema. This prevents mutation of the captured value.

**Repro:** `packages/patterns/repro-inline-handler-asopaque.tsx`

**To investigate:**
- Is this intentional (read-only by default) or a transformer bug?
- Can the transformer infer mutation intent from usage (e.g., seeing `.set()` calls)?
- Should there be a way to annotate inline handlers for write access?

**Workaround:** Use explicit `handler<unknown, { field: Cell<T> }>()` with typed state parameter.

### 3. mapWithPattern Cell Closure Bug

**Issue:** Cells captured from outer scope in `.map()` callbacks fail at runtime with "Cannot create cell link: space is required". The transformer correctly passes cells through params, but runtime doesn't hydrate them with space context.

**Repro:** `packages/patterns/repro-mapwithpattern-cell-closure.tsx` (on main branch)

**To investigate:**
- Is this a runtime hydration issue or a transformer issue?
- Should captured cells be handled differently than local cells in mapWithPattern?

### 4. Rename "charm" to "pattern" in ct CLI

**Issue:** The ct CLI uses `ct charm` subcommands, but we've standardized on "pattern" terminology in docs. This creates confusion.

**To consider:**
- Rename `ct charm` to `ct pattern` for consistency
- Or add `ct pattern` as an alias
- Update all docs/skills to use consistent terminology
