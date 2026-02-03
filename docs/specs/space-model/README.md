# Space Model Specification

This document specifies the data and execution model for Common Tools spaces,
covering the full stack from persistent storage at the lowest layer up through
transactions and the dataflow/reactivity system at the top.

## Purpose

This specification serves two purposes:

1. **Document the existing design**: Capture the current de facto architecture
   as implemented in the codebase, including behaviors that may not be
   explicitly documented elsewhere.

2. **Propose future directions**: Where the current design has known issues or
   opportunities for simplification, describe potential improvements.

Each topic document clearly separates these concerns:
- **Current State** sections describe how the system works today
- **Proposed** sections describe potential future directions
- **Open Questions** highlight areas needing further investigation or decision

## Scope

The specification addresses:

- **Data Model**: The immutable data representation — what values can be stored,
  special object shapes, and content addressing.

- **Storage**: How data is represented on disk and in databases, including the
  fact structure, persistence semantics, and encoding formats.

- **Identity and References**: How entities are identified, how references
  (links) between data are represented, and the sigil conventions for
  distinguishing references from inline data.

- **Cells**: The fundamental unit of reactive state — named locations that hold
  typed values and participate in the dataflow graph.

- **Transactions**: How reads and writes are grouped into atomic units, conflict
  detection, and consistency guarantees.

- **Reactivity**: How changes propagate through the system, the scheduling
  model, and the relationship between data changes and computation.

- **Schemas**: How data types are described, validated, and used to drive
  runtime behavior.

## Topics

- [Data Model](./0-data-model.md)
- [Storage Format](./1-storage-format.md)
- [Identity and References](./2-identity-and-references.md)
- [Cells](./3-cells.md)
- [Transactions](./4-transactions.md)
- [Reactivity](./5-reactivity.md)
- [Schemas](./6-schemas.md)
