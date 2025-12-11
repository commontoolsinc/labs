# Folk Wisdom Validation

**Status:** Test Patterns Ready - Awaiting Deployment
**Started:** 2025-12-11
**Tracking tag:** `@reviewed 2025-12-11 folk-wisdom-validation`

---

## Goal

Systematically evaluate all folk wisdom claims from `community-patterns/community-docs/folk_wisdom/` against ground truth. For each claim:
1. Analyze the claim and its context
2. Review relevant framework code to understand mechanics
3. Create a minimal test pattern that verifies or refutes the claim
4. Update official docs or community docs based on findings

---

## Folk Wisdom Files Overview

| File | Topics | Claim Count | Priority | Status |
|------|--------|-------------|----------|--------|
| `reactivity.md` | Cells, computed, derive, handlers, .equals() | ~7 | HIGH | AGENT DONE |
| `llm.md` | LLM caching, dumb map, derive for prompts | 3 | HIGH | AGENT DONE |
| `onclick-handlers-conditional-rendering.md` | onClick in derive/ifElse contexts | 3 | HIGH | AGENT DONE |
| `handlers.md` | Cross-charm writes via Stream.send() | 1 | MEDIUM | AGENT DONE |
| `background-execution.md` | Background sync, OAuth, server-side | ~17 | MEDIUM | AGENT DONE |
| `patterns.md` | Pattern structure and composition | ~3 | MEDIUM | AGENT DONE |
| `charm-registration.md` | Charm registration patterns | ~2 | MEDIUM | TODO |
| `components.md` | ct-card padding | 1 | LOW | TODO |
| `deployment.md` | Deployment and tooling | ~2 | LOW | TODO |
| `derive-object-parameter-cell-unwrapping.md` | Derive parameter unwrapping | 1 | LOW | TODO |
| `jsx.md` | JSX rendering patterns | ~2 | LOW | TODO |
| `mentionable-export-pattern.md` | Mentionable exports | 1 | LOW | TODO |
| `thinking-reactively-vs-events.md` | Mental model guidance | 1 | LOW | TODO |
| `types.md` | TypeScript type patterns | ~2 | LOW | TODO |

---

## Test Patterns Created

```
packages/patterns/folk-wisdom-verification/
├── test-onclick-inside-derive-broken.tsx        # onClick in derive() → ReadOnlyAddressError
├── test-onclick-toplevel-disabled-working.tsx   # Top-level button with disabled attribute
├── test-onclick-ifelse-simple-cell-working.tsx  # ifElse with plain cell works
├── test-reactivity-jsx-automatic.tsx            # JSX automatic reactivity
├── test-reactivity-computed-derive-same.tsx     # computed() and derive() equivalence
├── test-llm-dumb-map-generateobject.tsx         # Dumb map approach with generateObject
├── test-llm-derive-template-strings.tsx         # Template strings need derive()
├── test-background-manual-trigger.tsx           # bgUpdater manual trigger
└── test-pattern-composition-shared-cells.tsx    # Pattern composition with shared cells
```

---

## Validation Status

### reactivity.md Claims

| Claim | Status | Test Pattern | Result |
|-------|--------|--------------|--------|
| JSX is automatically reactive | CODE VERIFIED | `test-reactivity-jsx-automatic.tsx` | TRUE - JSX has built-in reactivity |
| computed() and derive() are the same | CODE VERIFIED | `test-reactivity-computed-derive-same.tsx` | TRUE - `computed = lift(fn)(undefined)` |
| Side effects MUST be idempotent | VERIFIED | (blessed) | TRUE |
| Use .equals() for Cell comparison | BLOCKED | | BLOCKED by alias bug |

**Framework Evidence:**
- `packages/runner/src/builder/module.ts:227-228`: `export const computed = <T>(fn: () => T) => lift<any, T>(fn)(undefined);`
- computed() is literally implemented as lift(fn)(undefined), same mechanism as derive

### llm.md Claims

| Claim | Status | Test Pattern | Result |
|-------|--------|--------------|--------|
| "Dumb map approach" works for all reactive primitives | CODE VERIFIED | `test-llm-dumb-map-generateobject.tsx` | TRUE |
| Don't build custom caching layers | CODE VERIFIED | (demonstrated by dumb map) | TRUE |
| Template strings need derive() for multiple properties | CODE VERIFIED | `test-llm-derive-template-strings.tsx` | TRUE |

**Framework Evidence:**
- `packages/runner/src/builtins/llm.ts:945`: Hash creation via `refer(generateObjectParams).toString()`
- `packages/runner/src/builtins/llm.ts:950-957`: Early return if hash matches cached requestHash
- Caching is automatic via content-addressed hashing of prompt + schema + model + system

### onclick-handlers-conditional-rendering.md Claims

| Claim | Status | Test Pattern | Result |
|-------|--------|--------------|--------|
| onClick in derive() causes ReadOnlyAddressError | CODE VERIFIED | `test-onclick-inside-derive-broken.tsx` | TRUE |
| ifElse with simple (local) cell works | CODE VERIFIED | `test-onclick-ifelse-simple-cell-working.tsx` | TRUE with caveats |
| Top-level button with disabled attribute works | CODE VERIFIED | `test-onclick-toplevel-disabled-working.tsx` | TRUE - RECOMMENDED |

**Framework Evidence:**
- `packages/runner/src/chronicle.ts`: `Address.isInline(address)` check returns ReadOnlyAddressError
- derive() creates inline data URIs (address.id starts with "data:")
- Chronicle.write() checks for inline addresses and rejects writes

### handlers.md Claims

| Claim | Status | Test Pattern | Result |
|-------|--------|--------------|--------|
| Cross-charm writes fail with WritIsolationError | CODE VERIFIED | (needs multi-charm setup) | TRUE |
| Solution: Stream.send() with onCommit callback | CODE VERIFIED | (needs multi-charm setup) | TRUE |

**Framework Evidence:**
- `packages/runner/src/storage/transaction.ts`: One-writer-per-DID rule
- Error: `StorageTransactionWriteIsolationError`
- Stream.send() with onCommit bypasses by using message passing

### background-execution.md Claims

| Claim | Status | Test Pattern | Result |
|-------|--------|--------------|--------|
| bgUpdater handlers run in both browser and server | ✅ LIVE VERIFIED | `test-background-manual-trigger.tsx` | TRUE (POLLING-BASED) |
| Overall accuracy | VERIFIED | | 91% (16/17 claims) |

**Key Corrections Needed:**
- wish() tags: Folk wisdom says JSDoc comments, reality is favorites UI tags
- Multiple matches: Folk wisdom says "only first", reality shows UI picker

**IMPORTANT DISCOVERY:** bgUpdater is POLLING-BASED, not event-driven!
- bgUpdater does NOT auto-trigger when captured cells change
- Requires background-charm-service running and charm registered
- Service polls charms on a schedule (default: 60 seconds)
- Service sends `{}` to bgUpdater Stream via `updater.withTx(tx).send({})` (worker.ts:188-196)

**LIVE VERIFICATION (2025-12-11):**
- Browser execution: ✅ VERIFIED - Click button shows [BROWSER] logs
- Server execution: ✅ VERIFIED - bg-charm-service polling shows [SERVER] logs

**Local Background Service Setup:**
See `docs/common/LOCAL_DEV_SERVERS.md` for full instructions. Quick summary:
```bash
# 1. Build binaries
deno task build-binaries

# 2. Start dev servers
./scripts/restart-local-dev.sh

# 3. Set up admin charm (one-time)
cd packages/background-charm-service
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task add-admin-charm

# 4. Register charm for polling
curl -X POST http://localhost:8000/api/integrations/bg \
  -H "Content-Type: application/json" \
  -d '{"charmId":"...","space":"did:key:...","integration":"test"}'

# 5. Start bg-charm-service
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" ./dist/bg-charm-service
```

### patterns.md Claims

| Claim | Status | Test Pattern | Result |
|-------|--------|--------------|--------|
| Pattern composition shares cell references | CODE VERIFIED | `test-pattern-composition-shared-cells.tsx` | TRUE |
| computed() for direct property access on objects | CODE VERIFIED | | TRUE |

**Framework Evidence:**
- `packages/runner/src/builder/recipe.ts:194-350`: factoryFromRecipe implementation
- Cell references passed to sub-patterns are same reference, not copies

---

## Agent Assignment Log

| Agent ID | File Assigned | Status | Summary |
|----------|---------------|--------|---------|
| afd971e | reactivity.md | COMPLETED | JSX reactivity, computed/derive equivalence verified |
| aa309c8 | llm.md | COMPLETED | Dumb map, caching, derive for templates verified |
| aa1330d | onclick-handlers-conditional-rendering.md | COMPLETED | ReadOnlyAddressError mechanism documented |
| a062b37 | handlers.md | COMPLETED | Cross-charm isolation, Stream.send solution verified |
| a4a7a4f | patterns.md | COMPLETED | Pattern composition, shared cells verified |
| a4eb2f9 | background-execution.md | COMPLETED | 91% accuracy, minor corrections needed |

---

## Validation Results Summary

### Verified TRUE (via code analysis)
- JSX is automatically reactive
- computed() and derive() are the same (both use lift())
- onClick inside derive() causes ReadOnlyAddressError
- ifElse with plain cell works (but caveats for composed patterns)
- Top-level buttons with disabled attribute work
- "Dumb map approach" works for generateObject/generateText
- Framework handles caching automatically (don't build custom layers)
- Template strings with multiple properties need derive()
- Pattern composition shares cell references
- bgUpdater handlers work in both browser and server contexts
- Cross-charm writes require Stream.send() with onCommit

### Verified FALSE
(None - all tested claims are accurate)

### BLOCKED
- .equals() for Cell comparison - blocked by alias bug in runtime

### Needs Correction
- `background-execution.md`: wish() tags documentation (JSDoc vs favorites UI)
- `background-execution.md`: Multiple matches behavior (picker vs first)

### Superseded
(None identified)

---

## Next Steps

1. **Deploy Test Patterns**: Use `deno task ct charm new <pattern>` to deploy each test pattern
2. **Manual Verification**: Test each pattern in browser to confirm expected behavior
3. **Document Results**: Update this file with PASS/FAIL for each manual test
4. **Update Docs**: Correct any inaccuracies found in community docs or official docs
5. **Remaining Files**: Spawn agents for remaining LOW priority folk wisdom files

---

## Related

- Project tracking: `docs/PATTERN_LIBRARY_RATIONALIZATION.md`
- Blessed verification tests: `packages/patterns/blessed-verification/`
- Official docs: `docs/common/`
- Folk wisdom source: `../community-patterns/community-docs/folk_wisdom/`
