---
name: knowledge-base
description: Shared foundation for Oracle & Corrector agents. Provides documentation structure map, source hierarchy rules, search location guide, and architecture overview. This skill establishes the authoritative source hierarchy and points to where knowledge lives in the codebase.
---

# Knowledge Base Foundation

## Overview

This skill provides the foundational knowledge map for the CommonTools codebase. It defines what documentation exists, where to find it, and - critically - which sources are authoritative when conflicts arise.

This is a **pointer skill** - it tells you where to look, not what the answers are. When you need specific technical details, consult the referenced documentation directly.

## Source Hierarchy (CRITICAL)

When sources conflict, this is the authoritative order:

1. **Specs** (`docs/specs/`) - Technical specifications with unambiguous intent
   - These are the source of truth for system design
   - When specs contradict other docs, specs win
   - Focus: architecture, data models, precise semantics

2. **Working code** - Tests and patterns that demonstrate actual behavior
   - `packages/patterns/` - Pattern examples showing what works
   - `**/test/**` - Test files proving expected behavior
   - These show reality, not aspirations

3. **Runtime code** - Core system implementation
   - `packages/runner/` - Recipe execution engine
   - `packages/builder/` - Pattern compilation
   - `packages/memory/` - Storage layer
   - Other packages (see architecture reference)
   - Code is always right about what it does

4. **Plain text docs** (`docs/common/`) - Guides, tutorials, learning materials
   - These are for learning and guidance
   - May contain outdated or speculative information
   - Validate against code when in doubt

**Rule of thumb:** Concrete beats abstract. Specifications beat speculation. Code beats comments. Tests beat documentation.

## Documentation Map

See `references/doc-map.md` for detailed breakdown of documentation structure.

High-level overview:

- `docs/common/` - Learning guides and tutorials (~6,200 lines, 15 files)
- `docs/specs/` - Technical specifications (~2,150 lines)
- `docs/future-tasks/` - Planning and analysis
- `docs/glossary.md` - Terminology reference
- `packages/patterns/INDEX.md` - Catalog of pattern examples

## Search Guide

Where to look based on what you need:

### Pattern Development Questions
- **Core concepts**: Start with `docs/common/PATTERNS.md` (main tutorial)
- **UI components**: `docs/common/COMPONENTS.md`
- **Reactivity/cells**: `docs/common/CELLS_AND_REACTIVITY.md`
- **Type system**: `docs/common/TYPES_AND_SCHEMAS.md`
- **Working examples**: `packages/patterns/` directory
- **Error reference**: `docs/common/DEBUGGING.md`

### Runtime/Architecture Questions
- **System design**: `docs/specs/recipe-construction/overview.md`
- **Architecture overview**: `references/architecture.md` in this skill
- **Development practices**: `docs/common/DEVELOPMENT.md`
- **Runtime operations**: `docs/common/RUNTIME.md`
- **Local dev setup**: `docs/common/LOCAL_DEV_SERVERS.md`

### Data Model Questions
- **Terminology**: `docs/glossary.md`
- **Core concepts**: Cell, Charm, Space, Spell, Recipe
- **Storage architecture**: Glossary entries for Heap, Nursery, Cache

### Integration/Testing Questions
- **UI testing**: `docs/common/UI_TESTING.md`
- **Pattern deployment**: `docs/common/PATTERN_DEV_DEPLOY.md`
- **LLM integration**: `docs/common/LLM.md`

### When Sources Conflict
1. Check specs first (`docs/specs/`)
2. Look at working code (tests, patterns)
3. Read runtime implementation
4. Use docs/common as learning guide only
5. If still unclear, ask explicitly which source to trust

## Key Terms (Quick Reference)

From `docs/glossary.md` - consult for full definitions:

- **Cell** - Unit of reactivity, like a spreadsheet cell
- **Charm** - Spell invocation with bound input/output cells (running instance)
- **Spell** - Unit of computation defining input-to-output transformation
- **Recipe/Pattern** - Function defining a reactive graph (interchangeable terms)
- **Space** - Sharing boundary with access control (identified by did:key)
- **Memory** - Abstraction over Space for accessing current/historical facts
- **Fact** - State record as `{the, of, is, cause}` tuple
- **Handler** - Event-driven code that updates cells
- **Storage tiers** - Nursery (local changes), Heap (session cache), Cache (IndexedDB)

## Architecture Overview

See `references/architecture.md` for component details and relationships.

Major packages:
- `runner` - Recipe execution engine
- `builder` - Pattern compilation
- `memory` - Storage layer
- `shell` - User interface shell
- `cli` - Command-line tools
- `patterns` - Pattern examples
- `ui` - UI component library
- `toolshed` - Development server

## Usage Guidelines

**DO:**
- Consult specs when understanding system design
- Look at working patterns for examples
- Check tests to understand expected behavior
- Follow the source hierarchy when resolving conflicts
- Use glossary for terminology clarity

**DON'T:**
- Treat learning docs as specifications
- Assume docs/common is always current
- Skip checking code when docs seem unclear
- Ignore the source hierarchy

## References

### references/doc-map.md
Detailed map of documentation structure, file purposes, and when to consult each.

### references/architecture.md
Major system components, their relationships, and where their code lives.

## Remember

This is a **navigation skill** - it tells you where knowledge lives and which sources to trust. When you need actual answers, follow the pointers to the authoritative sources. The hierarchy exists to resolve conflicts, not to discourage reading multiple sources.
