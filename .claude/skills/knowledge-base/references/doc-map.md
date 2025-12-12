# Documentation Structure Map

This reference details the complete documentation structure, what each file covers, and when to consult each.

## docs/common/ - Learning Guides (~6,200 lines, 15 files)

These are tutorial and reference materials for pattern development and runtime usage. They are **learning resources**, not specifications.

### Pattern Development Core

**PATTERNS.md** (1,255 lines) - Main tutorial
- START HERE for learning pattern development
- Levels 0-4 progression from basics to advanced
- Common patterns: lists, filtering, linking, composition
- When to use: Learning pattern development, understanding common idioms

**COMPONENTS.md** (740 lines) - UI component reference
- All available UI components (ct-* elements)
- Bidirectional binding with $ prefix
- Event handling patterns
- Style handling (object vs string)
- When to use: Building UIs, understanding component APIs

**CELLS_AND_REACTIVITY.md** - Cell system fundamentals
- Cell vs OpaqueRef distinction
- Computed values with derive()
- Reactive mental models
- When Cell<> wrapper is needed for write access
- When to use: Understanding reactivity, debugging cell issues

**TYPES_AND_SCHEMAS.md** - Type system guide
- Cell<> vs OpaqueRef<> usage
- Default<> type for default values
- When to use [ID] references
- Schema definitions
- When to use: Type errors, schema design

**DEBUGGING.md** (697 lines) - Error reference
- Common error patterns and solutions
- Type error troubleshooting
- Runtime error diagnosis
- Data update issues
- When to use: ANY time you encounter errors

**PATTERN_DEV_DEPLOY.md** - Development workflow
- Building patterns step-by-step
- Local development with `deno task ct dev`
- Deploying patterns with `ct charm`
- Testing workflows
- When to use: Setting up development, deployment questions

### Runtime & Integration

**RUNTIME.md** - Runtime package overview
- Running servers and services
- Testing strategies
- Runtime package structure
- When to use: Runtime development, server configuration

**DEVELOPMENT.md** - Coding standards
- Coding style guidelines
- Design principles
- Best practices
- When to use: Contributing code, code review

**LOCAL_DEV_SERVERS.md** - **CRITICAL** for development
- How to start dev servers correctly
- Use `dev-local` for shell, NOT `dev`
- Server configuration
- When to use: BEFORE starting any local development

**UI_TESTING.md** - Integration testing
- Shadow DOM handling in tests
- UI test patterns
- Testing best practices
- When to use: Writing or debugging integration tests

**LLM.md** - LLM integration guide
- Using generateText and generateObject
- LLM capabilities in patterns
- API reference
- When to use: Integrating AI features

### User Features

**CHARM_LINKING.md** - Linking charms together
- How to link charm outputs to inputs
- Data flow between charms
- When to use: Multi-charm workflows

**FAVORITES.md** - Favorites system
- Managing favorite charms
- When to use: User feature development

**HOME_SPACE.md** - Home space functionality
- Default user space
- When to use: Space management features

**CELL_CONTEXT.md** - Cell context system
- Context propagation
- When to use: Advanced cell patterns

## docs/specs/ - Technical Specifications (~2,150 lines)

These are **authoritative technical documents**. When specs conflict with other docs, specs win.

### Recipe Construction Spec

**specs/recipe-construction/overview.md** - Core system design
- Unified cell model (OpaqueRef + Cell)
- Capability-driven design
- Graph instantiation and serialization
- Cause generation for stable IDs
- Implementation phases and status
- When to use: Understanding core architecture, resolving design questions

**specs/recipe-construction/capability-wrappers.md** - Cell capabilities
- Opaque, Mutable, Readonly, Writeonly capabilities
- How capabilities map to operations
- When to use: Understanding cell access patterns

**specs/recipe-construction/cause-derivation.md** - ID stability
- How causes are derived
- Stable identifiers across edits
- When to use: Understanding cell identity

**specs/recipe-construction/graph-snapshot.md** - Graph persistence
- Runtime graph snapshot format
- Rehydration and teardown
- When to use: Understanding recipe persistence

**specs/recipe-construction/node-factory-shipping.md** - Serialization
- How node factories are serialized
- Cross-space shipping
- When to use: Advanced composition patterns

**specs/recipe-construction/pattern-integration-tests.md** - Test harness
- Integration test structure
- When to use: Writing integration tests

**specs/recipe-construction/rollout-plan.md** - Migration plan
- Phased rollout of new architecture
- Current implementation status
- When to use: Understanding what's implemented vs planned

### Other Specs

**specs/json_schema.md** - JSON schema support
- Schema validation
- When to use: Schema-related features

**specs/data-model/sigil.md** - Sigil format
- Data identification scheme
- When to use: Low-level data model work

## docs/future-tasks/ - Planning & Analysis

These are **speculative** documents for future work. They describe what might be, not what is.

- `unified-storage-stack.md` - Future storage improvements
- `ast.md` - AST-related future work
- `code-quality-tasks/` - Code quality analysis and tasks

When to use: Understanding future direction, but NOT for current implementation guidance.

## docs/glossary.md - Terminology Reference (227 lines)

Canonical definitions of system terms:
- Cell, Charm, Space, Spell, Recipe
- Storage tiers (Nursery, Heap, Cache)
- ACL, UCAN, CFC (security concepts)
- CRDT, VDOM (technical concepts)

When to use: ANY time you're unsure about terminology. Start here before diving into docs.

## packages/patterns/INDEX.md - Pattern Catalog

Catalog of all pattern examples with:
- Summaries of what each pattern does
- Data types used
- Keywords for searching

When to use: Finding example patterns, understanding pattern variety.

## Defunct Documentation

**TOP LEVEL recipes/ folder** - IGNORE THIS
- Legacy folder
- No longer maintained
- Do NOT use for reference

## Quick Decision Tree

**What do you need?**

- Learn pattern development → `docs/common/PATTERNS.md`
- Understand system design → `docs/specs/recipe-construction/overview.md`
- Fix an error → `docs/common/DEBUGGING.md`
- Find UI component → `docs/common/COMPONENTS.md`
- Understand a term → `docs/glossary.md`
- See working example → `packages/patterns/` + `INDEX.md`
- Start local dev → `docs/common/LOCAL_DEV_SERVERS.md` (read this FIRST!)
- Write integration test → `docs/common/UI_TESTING.md`
- Use LLM features → `docs/common/LLM.md`
- Understand reactivity → `docs/common/CELLS_AND_REACTIVITY.md`
- Fix type errors → `docs/common/TYPES_AND_SCHEMAS.md`

## Documentation Quality by Source

**Highest Trust (Specifications)**
- `docs/specs/recipe-construction/overview.md`
- Other `docs/specs/` files

**High Trust (Tests & Working Code)**
- `packages/patterns/` examples
- Test files throughout codebase

**Medium Trust (Core Runtime)**
- Code in `packages/runner/`, `packages/builder/`, `packages/memory/`

**Learning Trust (Tutorials)**
- `docs/common/` files - good for learning, verify with code for precision

**Low Trust (Speculative)**
- `docs/future-tasks/` - describes intentions, not reality

## When Documentation Seems Wrong

1. Check the spec in `docs/specs/`
2. Look at working patterns in `packages/patterns/`
3. Look at tests that verify the behavior
4. Read the runtime implementation code
5. If docs/common contradicts code, trust the code

The hierarchy exists because documentation can lag behind implementation. Always validate critical details against authoritative sources.
