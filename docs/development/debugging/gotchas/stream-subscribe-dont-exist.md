# Stream.subscribe() Doesn't Exist

**Error:** `Property 'subscribe' does not exist on type 'Stream<...>'`

**Symptom:** Trying to create or receive handler events by subscribing to a
`Stream`.

```typescript
// WRONG: Streams are not subscribed to directly
const addItem: Stream<{ title: string }> = new Stream();
addItem.subscribe(({ title }) => {
  items.push({ title });
});

// CORRECT: A bound handler IS the stream
const addItemHandler = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => { items.push({ title }); }
);
const addItem = addItemHandler({ items });  // This IS Stream<{ title: string }>

// Export it directly
return { addItem };
```

**Why:** Streams aren't created directly - they're the result of binding a handler with state. The bound handler IS the stream that can receive events.

## See Also

- @common/concepts/reactivity.md - Reactivity system
- @common/components/COMPONENTS.md - UI components and event handling
