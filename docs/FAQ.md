# FAQ Index

This is a **lightweight index** of frequently asked questions. Each entry contains:
- The question being asked
- A pointer to the documentation that answers it (file path and section reference)
- When the answer was last updated

**Important:** This file is an index only. Detailed explanations, reasoning, and context live in the actual documentation files referenced here. When an entry is added or updated, the reasoning for that change belongs in the git commit message.

When entries are added or modified, provenance can be found in this file's git history.

---

| Question | Answer Location | Last Updated |
|----------|-----------------|--------------|
| What type should handlers use in Output interfaces? | `docs/common/concepts/types-and-schemas/exported-handler.md` - Section "Handler Types in Output Interfaces". Use `Stream<T>` (not `OpaqueRef<T>`) for handlers in Output interfaces. `Stream<T>` represents a write-only channel that other pieces can call via `.send()`. | 2026-01-09 |
| How do I run the cf command? | `skills/cf/SKILL.md` - Section "Running CF". Always use `deno task cf [command]`. There is no binary to build or verify for normal development - `cf` runs TypeScript directly via deno. | 2026-03-25 |
| How do I compare objects for identity? Why does my custom `id` property not work? | `docs/common/concepts/identity.md` and `docs/development/debugging/gotchas/custom-id-property-pitfall.md`. Use `equals()` from `commonfabric`. Properties in `.map()` callbacks are Cells, not plain values. | 2026-03-25 |
| Why do I get "reactive reference outside context" when using input props in `[NAME]` or `new Writable()`? | `docs/development/debugging/gotchas/reactive-reference-outside-context.md`. Input props are reactive values that can only be accessed inside reactive contexts (`computed()`, `lift()`, JSX, event handlers). Wrap `[NAME]` in `computed()`, initialize cells with static values and set from event handlers. | 2026-01-14 |
| When should I use `action()` vs `handler()`? | `docs/common/concepts/action.md`. Use `action()` for most cases - it works inside patterns and closes over state. Use `handler()` only when you need to reuse the same logic with different state bindings or export for other patterns to call. | 2026-01-14 |
| How do I use SQLite in a pattern? | `docs/specs/sqlite-builtin/01-api.md` and `07-examples.md`. `sqliteDatabase({ tables })` returns a `SqliteDb` cell; call `db.query<Row>(sql, { reactOn: db })` for reactive reads and `db.exec(sql, params)` inside a handler for atomic writes. There is no standalone `sqliteExecute` builtin. | 2026-06-02 |
| How do cell references survive a round-trip through SQLite (`_cf_link`)? | `docs/specs/sqlite-builtin/02-cf-link-encoding.md`. A column whose name ends in `_cf_link` stores a cell as a sigil-link string. Decode-to-`Cell` on read is driven by a typed `db.query<{ col_cf_link: Cell<T> }>`; an untyped query returns the raw string. | 2026-06-02 |
