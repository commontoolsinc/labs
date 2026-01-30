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
| How do I run the ct command? | `.claude/skills/ct/SKILL.md` - Section "Running CT". Always use `deno task ct [command]`. There is no binary to build or verify for normal development - ct runs TypeScript directly via deno. | 2025-12-16 |
| How do I compare objects for identity? Why does my custom `id` property not work? | `docs/common/concepts/identity.md` and `docs/development/debugging/gotchas/custom-id-property-pitfall.md`. Use `equals()` from commontools. Properties in `.map()` callbacks are Cells, not plain values. | 2026-01-13 |
| Why do I get "reactive reference outside context" when using input props in `[NAME]` or `Writable.of()`? | `docs/development/debugging/gotchas/reactive-reference-outside-context.md`. Input props are reactive values that can only be accessed inside reactive contexts (`computed()`, `lift()`, JSX, event handlers). Wrap `[NAME]` in `computed()`, initialize cells with static values and set from event handlers. | 2026-01-14 |
| When should I use `action()` vs `handler()`? | `docs/common/concepts/action.md`. Use `action()` for most cases - it works inside patterns and closes over state. Use `handler()` only when you need to reuse the same logic with different state bindings or export for other patterns to call. | 2026-01-14 |
