# FUSE Testing Strategy

The FUSE package is complex to test end-to-end because it requires a
kernel-level filesystem mount. However, most of the interesting logic lives in
pure TypeScript and is testable without mounting anything. This document
outlines a layered testing strategy.

## Key insight: CellBridge ≠ FUSE mount

`CellBridge` manipulates an in-memory `FsTree`. The FUSE kernel adapter
(`mod.ts`) just reads from that tree. Most behaviors — directory structure,
manifest generation, name collision, reactive rename — are fully testable by
constructing a `CellBridge`, calling its methods with mocked pieces, and
inspecting `bridge.tree` directly.

---

## Layer 1: FsTree unit tests

**File:** `tree.test.ts` (doesn't exist yet)

`tree.ts` is pure data-structure logic — no async, no cells, no FUSE. Every
method (`addDir`, `addFile`, `lookup`, `rename`, `removeChild`, `clear`) can be
tested synchronously with zero mocking.

**Worth covering:**

- Basic add/lookup round-trips
- `rename` within the same parent and across parents
- `removeChild` clears children recursively
- Collision: adding two files with the same name
- `clear` resets a node without removing the inode

Having these would have caught the rename-before-mutation ordering bug (mutation
happened before `tree.rename()`, leaving state inconsistent on throw).

---

## Layer 2: CellBridge integration tests (no mount)

**File:** `cell-bridge.test.ts` (doesn't exist yet)

Test `CellBridge` directly by providing fake `PieceController` objects and
asserting on `bridge.tree` state. No FUSE mount, no kernel, no Toolshed.

### FakeCell / FakePieceController fixture

The key primitive is a controllable `Cell` — one that:

- Returns a configured value from `.get()`
- Stores sink callbacks so tests can fire them manually
- Has a `.getCell()` that returns itself (for `piece.result.getCell()`)

```typescript
class FakeCell<T> {
  private _value: T;
  private _sinks: Array<(v: T) => void> = [];

  constructor(value: T) {
    this._value = value;
  }

  get() {
    return this._value;
  }
  set(v: T) {
    this._value = v;
    this._sinks.forEach((fn) => fn(v));
  }
  async getCell() {
    return this;
  }
  sink(fn: (v: T) => void) {
    this._sinks.push(fn);
    return () => {
      this._sinks = this._sinks.filter((s) => s !== fn);
    };
  }
}

function makeFakePiece(id: string, name: string, opts?: {
  patternName?: string;
  summary?: string;
}): FakePieceController {
  // ...
}
```

### Behaviors worth covering

**Initial tree structure**

- After `connectSpace("myspace")`, verify `pieces/` dir exists
- Each piece has `meta.json`, `result/`, `input/` under its name
- `meta.json` contains `{id, name, patternName}`

**Manifest files**

- `.index.json` maps display names to entity IDs
- `pieces.json` contains `[{id, name, pattern, summary}]` per piece
- Both update correctly after `syncPieceListOnce` adds/removes pieces

**Name collision resolution**

- Two pieces with the same `name()` get `-2` suffix on the second
- After rename, the old name is freed and can be reused

**Rename on [NAME] change**

- Trigger the result cell sink (simulate a title change)
- After `setTimeout` fires, verify directory renamed in tree
- `.index.json` and `pieces.json` reflect new name
- Old name is freed from `usedNames`

**Add/remove sync**

- `syncPieceListOnce` adds pieces present in live list but not tree
- `syncPieceListOnce` removes pieces present in tree but not live list
- Invalidation callbacks are called with the right entry names

**Subscription cleanup**

- Removing a piece cancels its cell subscriptions

---

## Layer 3: CLI integration tests (subprocess, no mount)

**File:** `packages/cli/test/` (some tests exist already)

Run `ct piece get`, `ct piece call`, `ct piece ls` against a real Toolshed
instance and verify exit codes + output format.

**Worth covering:**

- `ct piece get <bad-path>` → exit 1, message contains "Available keys:"
- `ct piece get <good-path>` → exit 0, valid JSON
- `ct piece call handler --json` → exit 0 (no longer errors)
- `ct piece call handler <wrong-shape>` → stderr contains "invalid input shape"

---

## Layer 4: End-to-end mount tests (optional, CI-gated)

Requires FUSE-T (macOS) or fusermount (Linux) in the CI environment.

Mount a space, run real POSIX operations, verify behavior:

```bash
ct fuse mount /tmp/ct-test
ls /tmp/ct-test/myspace/pieces/         # piece directories visible
cat /tmp/ct-test/myspace/pieces/pieces.json  # manifest populated
echo '"new content"' > /tmp/ct-test/myspace/pieces/My\ Note/input/content
sleep 1
cat /tmp/ct-test/myspace/pieces/My\ Note/result/content  # updated
```

**Worth covering (if CI supports it):**

- Piece directories appear after mount
- Writing to `input/` updates the piece cell
- `result/` reflects reactive changes after a handler fires
- Directory renames when `[NAME]` changes (CT-1371)
- `pieces.json` updates when pieces are added/removed

These are slow and platform-specific. Gate them with an env var
(`CT_FUSE_E2E=1`) and don't block CI on failure until the suite is stable.

---

## Current coverage gaps (priority order)

1. **No `FsTree` unit tests** — highest value, zero infrastructure cost
2. **No `CellBridge` integration tests** — most logic lives here; a `FakeCell`
   fixture unblocks most of the interesting cases
3. **CLI tests don't cover error paths** — `ct piece get` bad-path behavior was
   broken and untested
4. **No mount-level regression tests** — acceptable for now, but needed before
   relying on FUSE in production agent workflows
