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
| What type should handlers use in Output interfaces? | `docs/common/concepts/types-and-schemas.md` - Section "Handler Types in Output Interfaces". Use `Stream<T>` (not `OpaqueRef<T>`) for handlers in Output interfaces. `Stream<T>` represents a write-only channel that other charms can call via `.send()`. | 2026-01-09 |
| How do I run the ct command? | `.claude/skills/ct/SKILL.md` - Section "Running CT". Always use `deno task ct [command]`. There is no binary to build or verify for normal development - ct runs TypeScript directly via deno. | 2025-12-16 |
