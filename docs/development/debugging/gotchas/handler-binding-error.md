# Handler Binding Error: Unknown Property

**Error:** `Object literal may only specify known properties, and 'X' does not exist in type 'Opaque<{ state: unknown; }>'`

**Symptom:** Trying to pass event data when binding a handler.

```typescript
// WRONG: Passing event data at binding time
const addItem = handler<
  { title: string },               // Event type
  { items: Writable<Item[]> }      // State type
>(({ title }, { items }) => { items.push({ title }); });

<button onClick={addItem({ title: "Test", items })}>  // Error!

// CORRECT: For test buttons, use inline handler
<button onClick={() => items.push({ title: "Test" })}>

// CORRECT: For real handlers, bind with state only
<ct-message-input onct-send={addItem({ items })} />
// Event data ({ title }) comes from component at runtime
```

**Why:** Handlers have two-step binding: you pass **state only** when binding. Event data comes **at runtime** from the UI component. For test buttons with hardcoded data, use inline handlers instead.

## See Also

- @common/concepts/reactivity.md - Reactivity system
- @common/components/COMPONENTS.md - UI components and event handling
