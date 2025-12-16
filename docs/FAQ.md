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
| When do I need to use `.get()` on cells? | `docs/common/CELLS_AND_REACTIVITY.md` - Section "3. In Inline Handlers" and "4. In handler() Functions". If the type is `Cell<T>`, use `.get()` to unwrap the value, regardless of whether it was passed as input or created with `Cell.of()`. | 2025-12-12 |
| Should I use `derive()` or `computed()` in patterns? | `docs/common/CELLS_AND_REACTIVITY.md` - Section "Reactive Computations with computed()". Always prefer `computed()` in patterns. While `derive()` works and can handle multiple inputs, `computed()` is the recommended API. | 2025-12-12 |
| Can I nest `computed()` calls? | `docs/common/CELLS_AND_REACTIVITY.md` - Section "Never Nest computed()". Never nest computed() - the inner call returns an OpaqueRef, not a value. Declare computed values separately instead. | 2025-12-12 |
| What type should handlers use in Output interfaces? | `docs/common/TYPES_AND_SCHEMAS.md` - Section "Handler Types in Output Interfaces". Use `Stream<T>` (not `OpaqueRef<T>`) for handlers in Output interfaces. `Stream<T>` represents a write-only channel that other charms can call via `.send()`. | 2025-12-12 |
| When do I need to use [ID] in my pattern? | `docs/common/CELLS_AND_REACTIVITY.md` - Section "Stable Array References with [ID]" and `docs/common/PATTERNS.md` - Level 1 example. Most patterns don't need [ID]. Use `Cell.equals()` for finding/removing items. Only use [ID] for stable UI state across item reordering (sorting, shuffling, inserting at front). | 2025-12-16 |
| Can I map over computed() results in JSX? | `docs/common/CELLS_AND_REACTIVITY.md` - Section "When to Use computed()" and "Debugging Reactivity Issues". YES! This is the canonical pattern. Compute filtering/transformations outside JSX with `computed()`, then map over the result inside JSX. The limitation is on inline filtering in JSX, not on mapping computed results. | 2025-12-16 |
| How do I run the ct command? | `.claude/skills/ct/SKILL.md` - Section "Running CT". Always use `deno task ct [command]`. There is no binary to build or verify for normal development - ct runs TypeScript directly via deno. | 2025-12-16 |
| Why does `lift()` fail with "Accessing an opaque ref via closure"? | `docs/common/CELLS_AND_REACTIVITY.md` - Section "lift() and Closure Limitations". `lift()` creates a new execution frame and cannot access reactive values from outer scopes via closure. Pass all reactive dependencies as explicit parameters: `lift((args) => args.g[args.d])({ g: grouped, d: date })`. Or use `computed()` instead - it handles closure extraction automatically via CTS transformation. | 2025-12-16 |
