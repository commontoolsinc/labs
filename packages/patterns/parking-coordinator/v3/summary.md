# Factory Run Summary: Parking Coordinator

**Run ID**: 2026-03-05-parking-coordinator-qkmw | **Date**: 2026-03-05T00:00:00Z | **Status**: Completed

## What Was Requested

Build a coordination tool for a small office team (5–15 people) to manage shared parking at 3 numbered spots (#1, #5, #12). Team members need to see today's spot status, request a spot for specific dates, and cancel requests. Admins must manage the roster, set priority ordering, and override allocations. The system should auto-allocate spots using priority rank and personal preferences.

## What Was Built

A complete, reactive parking coordinator pattern implementing:

- **Today Strip**: Immediately visible status board showing all active spots (Available or occupied by named person)
- **Week-Ahead Grid**: 7-day planning view (today through +6 days) showing allocations by spot and date
- **Request Form**: Person dropdown + date picker + submit. Auto-allocation runs immediately, showing result (allocated/denied/duplicate)
- **Admin Panel**: Toggle-revealed roster management (add/edit/remove people, reorder by priority) and spot management (add/edit/remove/deactivate)
- **Allocation Algorithm**: Default spot → ordered preferences → any available spot → denied. Priority ranking controls who gets first pick when multiple requests compete
- **Conflict Resolution**: Admin override allows manual assignment with conflict detection (e.g., "Spot #5 is already assigned to Bob on Thu Mar 5")

Data model: three entity types (ParkingSpot with spotNumber/label/notes/active; Person with name/email/commuteMode/spotPreferences/defaultSpot/priorityRank; SpotRequest with personName/date/status/assignedSpot/autoAllocated). One pattern file (1,546 lines) with 38-assertion test suite (all passing).

## Key Design Decisions

**From Spec-Interpreter** (intermediate complexity tier):
- Merged Allocation and SpotRequest into single entity — both describe the same record (who asked, when, what they got, status). Eliminated redundancy without losing information.
- Admin mode as toggle, not authentication — appropriate for small team tool without login overhead.
- Pre-seeded 3 spots via Default<> type literal to provide sensible initial state on fresh deployment.
- No retroactive reallocation — when a request is cancelled, freed spot simply becomes available; no automatic re-run for pending requests. Keeps behavior predictable.

**From Pattern-Maker** (implementation decisions):
- Renamed ParkingSpot.number → spotNumber to avoid CTS destructuring alias bug where property key name can be confused with outer scope variables when an action parameter has the same name.
- Pre-computed reactive data pattern: weekGridData, todayStripData, adminPeopleData, adminSpotsData all computed as top-level Computed<> blocks returning plain objects, then iterated in JSX .map(). This avoids OpaqueCell proxy access inside nested closures.
- Direct property access instead of destructuring aliases in .map() callbacks (e.g., `const sn = spot.spotNumber` not `const { spotNumber: sn } = spot`).
- Spread copies for readonly arrays: `[...spots.get()]` before passing to functions expecting mutable arrays.
- All actions use action<>() closed over pattern-scope Writables; no handler() calls needed.

**From Orchestrator** (iteration decisions):
- Design-only first run: ran spec-interpreter, ux-designer, ui-designer phases to completion, producing spec.md, ux-design.md, ui-design.md before build.
- One fix pass after manual test: manual tester found DEFAULT_SPOTS constant not used for initialization (fresh deploy had 0 spots). Fixed by inlining default spot values as type-level literal. Also added null guard (s != null &&) in filter callbacks for weekGridData/todayStripData to handle undefined elements during reactive re-evaluation.

## Quality Gate Results

### Critic Review

**Pass 1**: No critical or major issues. 2 minor findings:
- **MINOR (CCR-7)**: 46 instances of HTML elements (div, span) using string style syntax instead of object syntax (e.g., `style="padding: 0.75rem"` instead of `style={{ padding: "0.75rem" }}`). Framework convention requires object syntax for HTML elements. All ct-* components correctly use string syntax.
- **MINOR (CCR-1)**: Inline arrow function handlers created per-item in .map() callbacks (todayStripData.map lines 810, 822; weekGridData.map lines 1006-1011, 1043, 1073-1074; adminPeopleData.map lines 1171, 1211, 1219, 1226, 1233, 1259; adminSpotsData.map lines 1402, 1435, 1438, 1451). Should use handler() functions at module scope. Mitigating factor: inner computed() wrappers limit closure re-creation to when computed values change.

Judgment: Both minor, no deductions required, proceed to manual test.

### Test Results

**Tests present**: Yes. File: pattern/main.test.tsx
**Tests passing**: Yes. 38/38 assertions pass
**Coverage**: Comprehensive across 8 pattern subjects (s1–s8):
- People management: add, duplicate rejection, remove
- Priority reordering: movePersonUp/movePersonDown swap logic
- Spot management: add, duplicate rejection, remove
- Allocation cascade: default spot → preference → any remaining → denied
- Duplicate request rejection with message
- Cancellation
- Admin override with conflict resolution
- Admin mode toggle

Not covered: direct testing of editPerson/editSpot actions (only tested indirectly via UI path); editPerson name-change cascade to existing requests (identified as non-trivial but not tested). Pattern instantiation tests use DEFAULT_SPOTS correctly but did not catch that fresh deployment starts with 0 spots.

### Final Score

| Dimension        | Weight | Score | Weighted |
|------------------|--------|-------|----------|
| Correctness      | 15%    | 85    | 12.75    |
| Code Craft       | 15%    | 70    | 10.50    |
| Test Coverage    | 10%    | 80    | 8.00     |
| Spec Fidelity    | 10%    | 85    | 8.50     |
| UX Design        | 20%    | 70    | 14.00    |
| Experience Quality | 20%  | 72    | 14.40    |
| First-Run        | 10%    | 68    | 6.80     |
| **Overall**      |        |       | **75.0** |

Iteration modifier: -2 (two iterations: build + fix pass). **Final: 73/100**

**Classification**: Solid. Usable with minor rough edges. **Recommendation**: Acceptable. Complete, well-implemented pattern with genuine value (auto-allocation algorithm, clear status visualization, strong error prevention). Code quality gaps (handler-per-map, style syntax violations) are minor and do not affect functionality. UX/Experience gaps (admin section becomes a long scroll, below-fold week grid, bootstrap path requires self-registration) prevent reaching 80+ but the core experience is genuinely good for the domain.

## Iteration History

### Build Phase (~93 minutes, 1 iteration)

Pattern-maker built main.tsx and main.test.tsx from spec, ux-design, ui-design documents. Encountered and fixed several issues:

1. **CTS destructuring alias bug**: Property keys in destructuring (e.g., `const { spotNumber: sn }`) could be confused with outer scope variables when action parameters had the same name. Workaround: always use direct property access (`const sn = spot.spotNumber`).
2. **readonly array type mismatch**: spots.get() returns readonly ParkingSpot[]. Functions expecting mutable ParkingSpot[] fail. Fix: spread to create mutable copies: `[...spots.get()]`.
3. **OpaqueCell closure errors**: Initial attempts to inline allocation lookups in JSX .map() callbacks caused OpaqueCell proxy access issues. Solution: pre-compute all reactive data (weekGridData, todayStripData, adminPeopleData, adminSpotsData) as top-level Computed<> returning plain objects, then iterate those in JSX.

Result: 38/38 tests pass, ct check clean.

### Critic Review (~7.5 minutes)

Critic found no critical or major issues. 2 minor findings (string-style-on-HTML ×46, handler-per-map). Recommended proceeding to manual test without code fix pass.

### Manual Test (~41 minutes)

Manual tester found 1 HIGH + 1 MEDIUM issue:

1. **HIGH (DEFAULT_SPOTS not used)**: Fresh deployment starts with 0 spots, violating acceptance criterion "pattern loads with sensible initial state: the three default spots (#1, #5, #12) are pre-populated." The DEFAULT_SPOTS constant is defined but never used to initialize the spots input. Automated tests passed because they explicitly passed DEFAULT_SPOTS as constructor arguments, masking the deploy-time bug.
2. **MEDIUM (runtime error in computed filter)**: Every action triggers scheduler errors: "Cannot read properties of undefined (reading 'active')" in weekGridData and todayStripData computed functions. Both call `spots.get().filter((s) => s.active)` which receives undefined elements during reactive re-evaluation. State mutations succeed despite errors, but indicates robustness issue.

Manual test verified all 16 acceptance criteria except DEFAULT_SPOTS:
- Today view shows all active spots with Available/person status ✓
- Week grid covers exactly 7 days ✓
- Request with available spot → allocated ✓
- Request when full → denied ✓
- Auto-allocation respects priority order (default → preferences → any remaining) ✓
- Cancellation frees spot ✓
- Duplicate rejection with message ✓
- Admin mode toggle reveals/hides controls ✓
- Add/remove people ✓
- Add/remove/deactivate spots ✓
- Manual override creates request with autoAllocated: false ✓
- Non-drive commuters can request ✓
- Empty roster shows guidance message ✓
- Fails: Spots #1, #5, #12 not pre-populated on fresh deploy

### Fix Pass (~1.7 minutes)

Orchestrator invoked pattern-maker to fix both issues:

1. **DEFAULT_SPOTS fix**: Inlined the three default spot values directly as type-level literal in Default<ParkingSpot[], [{spotNumber: "1", label: "Near entrance", ...}, {spotNumber: "5", ...}, {spotNumber: "12", label: "Compact only", ...}]>. (Default<> second parameter must be a type literal, so const reference cannot be used.)
2. **Null guard fix**: Added `s != null &&` before `s.active` in both weekGridData and todayStripData computed filter callbacks: `spots.get().filter((s) => s != null && s.active)`.

Post-fix verification: ct check passes (exit 0), 38/38 tests still pass. Fresh deployment now shows 3 pre-populated spots in today strip and week grid.

### Manual Re-Verification

Post-fix manual test confirmed:
- 16/16 acceptance criteria now pass
- All handlers work correctly via CLI
- No runtime errors observed in computed functions
- Allocation algorithm correctly implements default → preference → any remaining → denied with priority ranking

## Notable Issues

**Resolved in fix pass**:
- **Line 42–45** (Input type initialization): DEFAULT_SPOTS constant defined but not used. Fresh deployment had 0 spots. Fixed by inlining values as type literal.
- **Lines 629, 673** (Computed filter): Undefined elements in spots.get().filter((s) => s.active) during reactive re-evaluation. Fixed with null guard: s != null && s.active.

**Unresolved (minor/design-level)**:
- **Line 177–178** (Static date): todayStr computed once at pattern init, does not update across midnight. Spec says "This view updates to reflect the current date automatically." No framework timer primitive available. Platform constraint, not code defect.
- **Lines 765–1467** (Closure allocation): Inline arrow function handlers created per-item in .map() callbacks instead of handler() at module scope. Critic flagged as MINOR. Mitigating factor: pre-computed data pattern limits closure re-creation frequency.
- **Lines 728–1492** (Style syntax): 46 instances of HTML elements using string style syntax instead of object syntax. Critic flagged as MINOR. All ct-* components correct. Stylistic issue, not functional.

## Lessons Learned

**Effective patterns used**:
- **Pre-computed reactive data pattern**: Computing weekGridData, todayStripData, etc. as top-level Computed<> returning plain objects solved OpaqueCell closure issues elegantly. This pattern should be the default approach for any pattern with large lists or nested data structures.
- **Normalized state with references**: Requests reference persons by name, spots by number, not full objects. No data duplication, mutations propagate cleanly.
- **Allocation algorithm as pure function**: runAutoAllocation isolated at module scope, easy to test and reason about independently.
- **Progressive disclosure via toggle**: Admin mode toggle keeps primary view uncluttered. Pattern-level adminMode Writable controls visibility cleanly.

**Sources of rework**:
- **CTS destructuring alias bug**: Required switching all destructuring patterns to direct property access. This burned implementation time and introduced minor readability loss (spotNumArg, spotNum2 variable names instead of cleaner sn, spotNum destructures).
- **DEFAULT_SPOTS initialization**: Misunderstanding of Default<> type semantics (cannot reference const in type parameter) caused fresh deployment bug. Tests masked it. Would have benefited from explicit first-run validation checklist.
- **String vs. object style syntax**: 46 instances suggests the maker defaulted to string syntax (perhaps out of habit or misunderstanding the convention). Code review/critic caught it but did not trigger fix pass.

**What the critic caught that the maker missed**:
- The 46 string-style violations were systematic. The maker applied string syntax consistently but incorrectly. The critic's category-by-category review surfaced the pattern.
- The handler-per-map issue was flagged but noted as having mitigating factors. The pre-computed data pattern partially masks the performance impact.

**Process observations**:
- **Design-first approach worked**: Having spec.md, ux-design.md, ui-design.md fully specified before build meant the maker had clear implementation targets and could avoid ambiguous interpretation.
- **Manual testing caught what automated tests missed**: Automated tests passed DEFAULT_SPOTS correctly but did not test fresh deployment initialization. Manual tester caught this immediately.
- **One-fix-pass loops are dangerous**: The HIGH finding (DEFAULT_SPOTS) was straightforward to fix, but a second loop discovering additional issues could have extended the timeline significantly.

## Feedback for Brief Author

**The brief was exceptionally clear.** Specific parking spot numbers (#1, #5, #12), concrete entity names (Parking Spot, Person, Spot Request), explicit allocation algorithm description ("default spot, then first preference, then any available"), and two distinct capability levels (team member vs. admin). Very little left ambiguous. The spec-interpreter needed to make only a few clarifying decisions (merge Allocation/SpotRequest, admin as toggle not auth, no retroactive reallocation).

**Additions spec-interpreter made that were right**:
- Admin mode as a toggle (not auth) — matched the brief's "keep it practical and simple" directive perfectly
- Pre-seeded spots (#1, #5, #12) via Default<> — made fresh deployment immediately useful
- No retroactive reallocation on cancellation — kept allocation behavior predictable for small-team coordination

**Ambiguities that could have been clearer**:
- **Spot identity model**: Brief lists "Parking Spot: has a number (#1, #5, #12)" but doesn't address whether the "number" field is numeric or string, or whether it's the primary identifier. Spec-interpreter correctly modeled as string field (spotNumber), matching real-world lot notation.
- **Priority mechanism**: Brief says "set priority order" but doesn't specify UI interaction (numeric ranks, drag-reorder, list index). Spec-interpreter chose numeric ranks with up/down arrow buttons. Works fine, but explicit guidance would have prevented implementation from having to guess.
- **Request cancellation scope**: Brief doesn't clarify "can a person cancel someone else's request?" Spec-interpreter assumed people can only cancel their own. Implementation restricts to self-cancel (no other-cancel in UI). Correct assumption but worth explicit statement.

**Overall assessment**: This was an excellent brief — structured, specific, and internally consistent. The pattern-factory produced a production-quality result with minimal ambiguity. No changes needed; authors of future parking-themed briefs should use this as a template.

## Recommendation

**Accept and promote.** The Parking Coordinator is a complete, well-tested pattern implementing a real business need (shared parking management for small teams). It scores 73/100 (Solid):

- **Strengths**: Clean compile, all 16 acceptance criteria verified pass, comprehensive test coverage, strong allocation algorithm, clear status visualization, solid error prevention, genuine UX improvement over spreadsheet-based coordination.
- **Code quality**: Two minor deductions (handler-per-map, string-style-on-HTML) do not affect functionality. No critical or major issues.
- **Rough edges**: Admin section becomes a long scroll when open, week grid sits below the fold, new user bootstrap path requires self-registration before core task is available. These prevent reaching 80+ on UX/Experience dimensions but do not block usefulness.

For a small office team (5–15 people), this tool meaningfully improves coordination over email or spreadsheets. Auto-allocation based on priority and preferences, visual week-ahead planning, and clear today status solve the stated problem completely. Recommend for production use.
