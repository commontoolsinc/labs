# FUSE Filesystem for Common Tools Spaces

**Status:** Draft

A FUSE filesystem that exposes Common Tools spaces and cells as a standard
filesystem. Read and write operations on files map to cell reads and writes.
Directory listings reflect space contents and JSON structure traversal.

## Document Map

- [1. Overview and Motivation](./1-overview.md)
- [2. Path Scheme and Filesystem Layout](./2-path-scheme.md)
- [3. JSON-to-Filesystem Mapping](./3-json-mapping.md)
- [4. Read/Write Semantics](./4-read-write.md)
- [5. Architecture](./5-architecture.md)
- [6. Reactivity and Caching](./6-reactivity.md)
- [7. Open Questions](./7-open-questions.md)
