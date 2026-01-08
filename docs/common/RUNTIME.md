<!-- @reviewed 2025-12-10 docs-rationalization -->

# Runtime Development Guide

This guide covers working on CommonTools runtime components including the backend (Toolshed), frontend (Shell), and core runtime packages.

## Architecture Overview

Common Tools consists of several runtime components:

- **Toolshed** (`packages/toolshed/`) - Backend API server providing distributed runtime and storage
- **Shell** (`packages/shell/`) - Web frontend for interacting with spaces
- **Runner** (`packages/runner/`) - Pattern runtime execution engine
- **Background Charm Service** (`packages/background-charm-service/`) - Background service for running charms in Deno workers
- **Storage** - Storage layer implementation (`packages/memory/`, `packages/runner/src/storage/`)
- **Identity** (`packages/identity/`) - Identity management and cryptographic key handling

### Working with Storage

The storage system uses MVCC transactions:

- See `packages/runner/src/storage/transaction-explainer.md` for transaction model details
- See `packages/runner/src/storage/transaction-implementation-guide.md` for implementation guide

## Module Graph Considerations

Runtime code runs in multiple environments:

- Browsers (Vite built)
- Browsers (deno-web-test>esbuild Built)
- Browsers (eval'd patterns)
- Deno (scripts and servers)
- Deno (eval'd patterns)
- Deno Workers
- Deno workers (eval'd patterns)

See [DEVELOPMENT.md](./DEVELOPMENT.md) for detailed module graph best practices.
