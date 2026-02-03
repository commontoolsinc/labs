# Space Model Specification

This document specifies the data and execution model for Common Tools spaces,
covering the full stack from persistent storage at the lowest layer up through
transactions and the dataflow/reactivity system at the top.

## Scope

The specification addresses:

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

- [Storage Format](./storage-format.md)
- [Identity and References](./identity-and-references.md)
- [Cells](./cells.md)
- [Transactions](./transactions.md)
- [Reactivity](./reactivity.md)
- [Schemas](./schemas.md)
