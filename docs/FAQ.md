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
