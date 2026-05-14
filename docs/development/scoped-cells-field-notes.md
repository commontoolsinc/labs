# Scoped Cells Field Notes

Running log of hard-won knowledge, things that went wrong, and suspected bugs
encountered while building patterns with the scoped cell instances feature
(`PerSpace`, `PerUser`, `PerSession`). Use this to refine the runtime, docs,
and authoring guidance.

For solutions-oriented advice, see also
[`debugging/gotchas/scoped-cell-pitfalls.md`](./debugging/gotchas/scoped-cell-pitfalls.md).

---

## 2026-05-14 — Cozy lunch poll build

Built `packages/patterns/cozy-poll-scoped/` as a multi-user voting pattern.
Established what works, what doesn't, and what looks broken in the runtime.

### What worked (validated end-to-end)

- **`PerSpace` shared state.** `users[]`, `options[]`, `votes[]`, `adminName`,
  `question` all read and write correctly from any user.
- **`PerUser` isolated state.** `myName` is per-DID; one user's value doesn't
  leak to another. Concretely observable: CLI `inspect` running as
  `claude.key` shows `myName: ""` while the browser session shows `"Alex"` —
  same cell id, different scope key.
- **Derived scope checks.** `isJoined = derive(myName, …)` and `isAdmin =
  derive({myName, adminName}, …)` flip correctly when their dependencies
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
   `derive(users, u => u.length)`. Nested access through an object cell
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

### Suspected runtime bugs (for system designers)

#### B1. `onClick={() => boundFoo.send({…})}` inside a `.map()` callback silently fails

**Severity:** Blocking for any pattern that wants per-item actions on a
dynamic list (which is most non-trivial collaborative patterns).

**Repro:** `packages/patterns/cozy-poll-scoped/main.tsx` deployed to local
toolshed (`fid1:l1bj7B-…` in this session). Top-level `<cf-button
onClick={boundAddOption}>` fires its handler correctly. Inside
`ranked.map((tally) => …)`, every vote button using `<cf-button onClick={()
=> boundCastVote.send({ optionId: oid, voteType: "green" })}>` and the
Remove button with `onClick={() => boundRemoveOption.send({ optionId: oid
})}` do **not** fire. Verified via:

- Real Playwright `getByRole('button', { name: '🟢 Love it' }).click()` lands
  on the cf-button host (per `cf-button.ts:99-114` the host's click listener
  runs).
- After the click, `cf piece inspect` shows `votes: [Array(0)]` and
  `options: [Array(1)]` unchanged — the handler did not run.
- No console errors from the pattern itself (only the unrelated
  `summary-index.tsx: piece.get is not a function` that Berni already
  flagged in PR #3584).

**Things that did not change the behavior:**
- Hoisting `tally.option.id` to a local `const oid` before the lambda (so
  the lambda captures a plain identifier, not a nested property access).
- Real Playwright `.click()` vs. manual `MouseEvent` dispatch on the inner
  shadow `<button>` element.

**Reference pattern that uses the same shape and works:**
`packages/patterns/scoped-group-chat/main-plain-inputs.tsx:248-256` —
`onClick={() => boundSelectRoom.send({ room })}` inside `rooms.map(…)`. The
diffs vs. cozy-poll: it's `cf-tab` not `cf-button`, and the captured loop
var is the whole object rather than a derived primitive. But pattern-critic
inspected cozy-poll under its full checklist and reported 34/0/0 — the
pattern code itself is not the problem.

**Pattern-critic's guess (worth investigating):** the bug is in the dispatch
path when a stream `.send()` is invoked from a closure created inside a
`.map()` callback. Likely candidates:
- The transformer not capturing the bound stream correctly into the map
  closure
- The bound stream losing its connection to its underlying cells when called
  through a closure that was constructed inside a reactive map
- Some interaction with how the scope-aware reactive system tracks the
  dispatcher's read set when invoked from a deep closure

**Workarounds suggested but not yet verified:**
- Hoist the lambda creation into a helper `createVoteHandler(oid, voteType)`
  called at pattern scope.
- Wrap the lambda in `action(() => …)`.
- Refactor to a handler that takes `optionId` as a bound input rather than
  as a closure capture.

If any of these work, the runtime should probably print a deprecation-style
warning when the bare lambda shape is used; if none work, this is a real
runtime bug.

#### B2. `userCount = users.length` doesn't lift reactively

See "what we got wrong" #2 above. Maybe-intentional, but the asymmetry with
nested `object.array.length` is surprising and there's no compile-time hint.

#### B3. Initial reactive output reads can be `undefined` before defaults hydrate

See "what we got wrong" #5. Either the defaults should materialize before
the pattern body runs, or there should be a "settled" signal authors can
wait on in tests.

### Open questions to bring to Berni

- Is **B1** known? If so, what's the canonical workaround for per-item
  actions in a `.map()` over a scoped list?
- Is the `me: PerUser<{user?: User}>` link-pointer idiom we built first
  (proved in `scoped-user-directory/`) "first-class" or just incidentally
  working? The architect's stated guidance was to use it; the scrabble
  pattern doesn't. Worth picking one and documenting.
- The CFC-integrity admin direction in
  `packages/patterns/cozy-poll-scoped/ADMIN-FUTURE.md` — what's the realistic
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
