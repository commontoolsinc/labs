# Testing Checklist

## Core System Testing

- Multi-doc tx atomicity & invariants.
- Read conflict resolution.
- Large histories + snapshot cadence.
- Catch-up via subscription from old epoch.
- Merge correctness & branch closure.
- Idempotency via `clientTxId`.

## Query Subscription Testing

### Basic Query Functionality

- **Schema compilation**: Test JSON Schema to IR compilation for all node types
- **Simple queries**: Basic type checks, const values, enum matching
- **Object queries**: Required properties, additionalProperties behavior
  (omit/false/true/schema)
- **Array queries**: Items validation, tuple schemas
- **Combinators**: allOf, anyOf with various combinations
- **Recursive schemas**: $ref with /definitions, cycle detection, reference
  depth limits
- **Link following**: Basic link dereferencing within depth bounds
- **Depth limits**: Verify maxLinkDepth enforcement and MaybeExceededDepth
  handling

### Incremental Evaluation

- **Memoization**: Verify identical queries share evaluation cache
- **IR sharing**: Test hash-consing of identical sub-schemas
- **Provenance tracking**: Ensure exact link touches are recorded
- **Dependency tracking**: Verify eval node dependencies are correctly
  maintained
- **Touch set minimality**: Confirm only required links are watched

### Change Propagation

- **Link-level invalidation**: Test that changes to specific links trigger
  re-evaluation
- **Topological re-evaluation**: Verify dirty nodes are processed in correct
  order
- **Touch set changes**: Test notifications when Touch Set expands/shrinks
- **Link topology changes**: Test when links are added/removed
- **Overlapping queries**: Verify multiple queries sharing IR nodes work
  correctly

### Edge Cases

- **Cycles**: Test link cycles with various depth budgets
- **Recursive cycles**: Test $ref cycles with various reference depths
- **Missing properties**: Verify touching missing properties works correctly
- **Array mutations**: Test array insertions/deletions affect correct indices
- **Deep nesting**: Test queries on deeply nested structures
- **Large documents**: Performance with documents containing many
  properties/items
- **Schema evolution**: Test queries when document schema changes over time

### Performance Testing

- **Query sharing**: Measure performance benefits of IR sharing
- **Incremental updates**: Compare incremental vs full re-evaluation performance
- **Memory usage**: Test memory consumption with many active queries
- **GC behavior**: Verify unused IR nodes and eval cache entries are cleaned up
- **Concurrent queries**: Test system behavior under high query load

### WebSocket Integration

- **Subscription lifecycle**: Test subscribe/unsubscribe/ack flow
- **Backpressure**: Test behavior when client falls behind
- **Reconnection**: Test query state recovery after WebSocket reconnection
- **Batch notifications**: Test coalescing multiple query updates
- **Error handling**: Test graceful handling of malformed queries

### Integration Testing

- **Transaction integration**: Test query updates triggered by document changes
  in transactions
- **Space isolation**: Verify queries are properly scoped to spaces
- **UCAN integration**: Test query permissions and authorization
- **Point-in-time queries**: Test queries on historical document states
- **Branch queries**: Test queries on different branches of the same document

### Stress Testing

- **Many concurrent queries**: Test system with hundreds of active queries
- **Complex schemas**: Test with deeply nested, complex JSON schemas
- **Frequent changes**: Test with rapid document mutations
- **Large touch sets**: Test queries that touch many documents
- **Memory pressure**: Test behavior under memory constraints
