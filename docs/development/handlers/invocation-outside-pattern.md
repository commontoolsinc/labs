# Invoking Handlers from Outside a Pattern

This guide explains how to programmatically invoke a handler stream from `RuntimeProcessor` or anywhere outside the pattern context.

## Steps

### 1. Get the piece cell

```typescript
// Shown inside a pattern body.
const pieceCell = someCell.resolveAsCell();
```

### 2. Apply schema with `{ asCell: ["stream"] }` on the handler property

```typescript
// Shown inside a pattern body.
const cell = pieceCell.asSchema({
  type: "object",
  properties: {
    handlerName: { asCell: ["stream"] },  // <-- THIS IS THE KEY
  },
  required: ["handlerName"],
});
```

### 3. Get the handler and call `.send()` directly

No transaction needed:

```typescript
// Shown as JSX element children.
const handlerStream = cell.key("handlerName");
handlerStream.send({ eventData });
```

### 4. Wait for processing

```typescript
// Shown inside a pattern body.
await runtime.idle();
```

## Why it works

The `{ asStream: true }` in the schema tells the cell that this property is a stream. When you call `.send()` on a stream-marked cell, it internally uses `scheduler.queueEvent()` which triggers the registered handler.

## What doesn't work

| Approach | Result |
|----------|--------|
| `.send()` without the schema | Treated as a regular cell, just stores the value |
| `scheduler.queueEvent()` directly | Handler wasn't registered |
