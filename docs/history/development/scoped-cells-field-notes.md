---
status: historical
created: 2026-05-14
archived: 2026-07-08
reason: "Dated field journal from building the first scoped-cell patterns."
---

# Scoped Cells Field Notes

Running log of hard-won knowledge, things that went wrong, and suspected bugs
encountered while building patterns with the scoped cell instances feature
(`PerSpace`, `PerUser`, `PerSession`). Use this to refine the runtime, docs,
and authoring guidance.

For solutions-oriented advice, see also
[`debugging/gotchas/scoped-cell-pitfalls.md`](../../development/debugging/gotchas/scoped-cell-pitfalls.md).

---

## 2026-05-14 — Cozy lunch poll build

Built `packages/patterns/cozy-poll/` as a multi-user voting pattern.
Established what works, what doesn't, and what looks broken in the runtime.

### What worked (validated end-to-end)

- **`PerSpace` shared state.** `users[]`, `options[]`, `votes[]`, `adminName`,
  `question` all read and write correctly from any user.
- **`PerUser` isolated state.** `myName` is per-DID; one user's value doesn't
  leak to another. Concretely observable: CLI `inspect` running as
  `claude.key` shows `myName: ""` while the browser session shows `"Alex"` —
  same cell id, different scope key.
- **Derived scope checks.** `isJoined = computed(() => …)` and `isAdmin =
  computed(() => …)` flip correctly when their dependencies
  update.
- **First-writer-wins admin claim.** The handler that does `if
  (adminName.get() === "") { adminName.set(me); }` works correctly. The
  underlying OCC machinery (read attestation → `claim()` on commit → retry on
  `StorageTransactionInconsistent`) protects against simultaneous claims,
  verified earlier in this session by tracing `scheduler.ts:1480` and
  `transaction/chronicle.ts:270-308`.
- **Name-as-identity idiom.** Following the scrabble pattern, we used
  `myName: PerUser<string>` with `Player.name === currentUserName` for "is
  this me." Names immutable after join. Simple, no DID exposure needed in
  patterns.

### What we got wrong on the first attempt

These are the things that bit during the build. Each is also captured in
`debugging/gotchas/scoped-cell-pitfalls.md`.

1. **Picked the wrong identity idiom first.** Initially designed a
   `users: PerSpace<User[]>` directory with `me: PerUser<{user?: User}>`
   pointing-link into it. Verified the link mechanism works
   (`packages/patterns/scoped-user-directory/`), then realized Berni's actual
   scrabble pattern uses just name strings everywhere — simpler and proven.
   The link-pointer technique is correct and works; it's just usually
   unnecessary.

2. **`.length` on a top-level `PerSpace<Array>` doesn't lift reactively.**
   `users.length` snapshots once. Have to write
   `computed(() => users.length)`. Nested access through an object cell
   (`conversation.rooms.length`) works fine, but a top-level array does not.
   First version of the test reported `undefined` for `userCount`.

3. **Scoped cells in the pattern body can't be `.get()`'d from JSX onClick.**
   `joinName: PerSession<string>` in the pattern body has type
   `string & {SCOPE_BRAND}` — there is no `.get()`. Idiom is to have the
   handler accept `name?: string` in the event and fall back to
   `joinName.get()` from its own bindings.

4. **Pattern outputs need explicit `computed(() => cell.get())` to be plain
   types.** Returning `PerSpace<User[]>` directly as an output made
   `subject.users[0]?.name` read `undefined` from the test pattern.

5. **Initial-state assertions can race with default hydration.** Asserting
   anything pre-action reads `undefined`. Scrabble's tests skip this entirely;
   we did the same.

6. **`Math.random()` is blocked by SES.** Use `nonPrivateRandom()`. Not
   scope-specific but came up writing a per-option ID generator.

### Runtime bugs

#### B1. `onClick={() => stream.send({...})}` is sometimes lowered as a `derive(...)` wrapper instead of a handler — FIXED (CT-1589 / PR #3595)

**Status:** Fixed in `bbf4642cc [codex] fix ts-transformers inline handler
sends (#3595)`, merged 2026-05-14. Filed as
[CT-1589](https://linear.app/common-tools/issue/CT-1589/transformer-wraps-some-onclick-lambdas-in-derive-instead-of-leaving)
and verified resolved end-to-end after rebasing the branch onto main.

**Root cause:** For some patterns the ts-transformer hoisted the JSX `onClick`
lambda into a top-level `const __cfModuleCallback_N = __cfHardenFn(...)` and
wrapped its body in `__cfHelpers.derive(inputSchema, { asCell: ["opaque"] },
captures, body)` — treating the click handler as a reactive expression that
should compute an opaque value, rather than as an event handler. The stream
`.send` never fired.

PR #3582 (`fix(ts-transformers): lower property access in module-extracted
callbacks`) was unrelated — it covered a different layer of the same general
problem. Cherry-picking it locally did not fix this.

**Verification after PR #3595:**

```bash
deno task cf check packages/patterns/cozy-poll/main.tsx --show-transformed \
  | grep -c __cfModuleCallback
# → 0 (was 4 pre-fix, 8 with PR #3582 cherry-picked)
```

The vote onClick now lowers to a bare
`(__cf_handler_event, { boundCastVote, oid }) => boundCastVote.send({...})`
at the call site. End-to-end browser test: clicking 🟢 Love it landed
`votes: [Array(1)]` and rendered the voter chip with selected state.

PR #3595 added a transformer fixture
(`packages/ts-transformers/test/fixtures/closures/map-conditional-inline-handler-send.*`)
that locks this case in.

#### B2. ~~`array.length` on a top-level scoped array doesn't lift reactively~~ — NOT A BUG

**Status:** Investigated and closed. Per `--show-transformed` analysis,
both `items.length` and `computed(() => items.length)` lower to the same
underlying reads. The behavioral diff observed in the first cozy-poll test
was likely an artifact of how the test asserted (see B3) or a misread.

If someone *does* see `arr.length` go stale on a scoped array in the
future, file fresh evidence here — but it's not currently a known runtime
bug.

#### B3. ~~Initial reactive output reads can be `undefined`~~ — NOT A BUG

**Status:** Investigated and closed. Verified with a minimal `PerSpace<number
| Default<0>>` pattern that `subject.value === 0` passes as the very first
test assertion (no prior action). Default values hydrate correctly.

The `Expected true, got undefined` failure in cozy-poll's test was JS
short-circuit propagation through a long `A && B && C && …` chain in the
test's assertion `computed()`, **not** a runtime hydration race. Fix is to
split compound assertions into individual ones, or coerce with
`Boolean(...)`.

#### B4. Cozy-poll UI rewrite renders blank — FILED (CT-1597)

**Status:** Filed as
[CT-1597](https://linear.app/common-tools/issue/CT-1597/cozy-poll-scoped-ui-rewrite-renders-blank-bisection-rules-out-style).
The substantial canonical-UI rewrite (commit
[`93d545ad6`](https://github.com/commontoolsinc/labs/commit/93d545ad6) on
this branch) renders **completely blank** in the browser despite passing
unit tests and `cf check`.

Bisection harness at `packages/patterns/scope-bug-computed-vnode-blank/main.tsx`
rules out four suspected mechanisms (style-derive-as-object,
style-derive-as-string, multiple top-level `{computed(() => <VNode/>)}`
blocks, and `cf-input $value=` inside `computed`). All four work fine.

The trigger remains unidentified — likely something specific to the
`<cf-screen>` + `slot="header"` + `<cf-vscroll>` shell or the
`<cf-card>` nesting inside the WIP rewrite's `computed` blocks. Next
investigation step (left to whoever picks up CT-1597): start from the
WIP commit and progressively comment out sections until the pattern
renders.

#### B5. CLI `cf piece inspect` doesn't reflect the caller's PerUser values — FILED (CT-1598)

**Status:** Filed as
[CT-1598](https://linear.app/common-tools/issue/CT-1598/cf-piece-inspect-doesnt-reflect-the-callers-peruser-values-even-when).
`cf piece inspect --identity <key>` reads PerUser fields like `myName` as
empty `""` regardless of which identity inspects, even when that identity
has demonstrably written a value (verified via per-space consequences
like `votes[].voterName`). Handlers see the correct per-user value;
inspect doesn't.

Workaround for multi-user testing: verify per-user behavior via PerSpace
consequences (vote attribution, directory entries) rather than via the
inspect view of PerUser fields.

The `Expected true, got undefined` failure in cozy-poll's test was JS
short-circuit propagation through a long `A && B && C && …` chain in the
test's assertion `computed()`, **not** a runtime hydration race. Fix is to
split compound assertions into individual ones, or coerce with
`Boolean(...)`.

### Open questions to bring to Berni

- Is **B1** known? If so, what's the canonical workaround for per-item
  actions in a `.map()` over a scoped list?
- Is the `me: PerUser<{user?: User}>` link-pointer idiom we built first
  (proved in `scoped-user-directory/`) "first-class" or just incidentally
  working? The architect's stated guidance was to use it; the scrabble
  pattern doesn't. Worth picking one and documenting.
- The CFC-integrity admin direction in
  `packages/patterns/cozy-poll/ADMIN-FUTURE.md` — what's the realistic
  ETA, and what's the right way to design admin authority *now* if we ship
  patterns before CFC integrity is plumbed?

---

## How to use this file

When you hit something while building a scoped pattern:

- **Solved it cleanly** → add a fix to
  `debugging/gotchas/scoped-cell-pitfalls.md`.
- **Worked around it but it felt wrong** → add a note here under "What we got
  wrong" or "Suspected runtime bugs," dated.
- **Couldn't work around it** → add to "Suspected runtime bugs" with a
  concrete repro path and what you tried.

The goal of this doc is to give the runtime/spec authors a focused list of
real-world friction, not to be a tutorial.
