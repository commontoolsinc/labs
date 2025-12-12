# System Architecture Reference

High-level component map. For details, read the actual code and specs.

## Core Components (packages/)

### Execution & Compilation
- **runner/** - Recipe execution engine, scheduler, cell graph management
  - `src/builder/` - Pattern compilation (OpaqueRef, recipe factory)
- **memory/** - Storage layer (Nursery/Heap/Cache tiers, fact model, spaces)

### User Interface
- **shell/** - Main UI shell application
- **ui/** - UI component library (ct-* web components)

### Development Tools
- **cli/** - `ct` binary (dev, charm management, deployment)
- **toolshed/** - Development server

### Examples & Patterns
- **patterns/** - Working pattern examples (see INDEX.md for catalog)

### Supporting
- **js-compiler/** - TypeScript/CTS compilation
- **ts-transformers/** - Custom TypeScript transformers
- **js-sandbox/** - Sandboxed JavaScript execution
- **llm/** - LLM integration
- **integration/** - Integration tests
- **api/** - API definitions

## Component Relationships

```
Shell (UI) → Runner (execution) → Memory (storage)
                ↑
             Builder (compilation)
```

Pattern development: CLI → Builder → Runner → Memory

## Where to Look

**Understanding execution**: `packages/runner/` + specs
**Understanding storage**: `packages/memory/` + glossary
**Understanding patterns**: `packages/patterns/` + docs/common
**Understanding compilation**: `packages/runner/src/builder/` + specs

## Key Files by Question

- How patterns compile: `packages/runner/src/builder/recipe.ts`
- How cells work: `packages/runner/` (scheduler, cell creation)
- How facts are stored: `packages/memory/` core modules
- How IDs are derived: `packages/runner/src/create-ref.ts`
- What components exist: `packages/ui/` source files

This is a **pointer reference** - follow the paths to actual code and documentation.
