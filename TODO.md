# Form Abstraction TODO

## Current State

We're implementing a "write gate" form abstraction where form fields buffer
writes locally and the form coordinates submission.

### What's Working

- ct-form provides FormContext to child fields
- Form fields (ct-input, ct-select, ct-checkbox, ct-textarea) register with form
- Fields buffer writes locally when in form context
- ct-button type="submit" correctly triggers ct-form.submit() across shadow DOM
- Form validates all fields before emitting submit event
- Form emits `ct-submit` with serializable `{ values: { name: value, ... } }`
  object

### Current Issue

**Event serialization**: Common Tools serializes events across worker
boundaries. We updated ct-form to emit only JSON-serializable data (no
functions/DOM elements). The pattern now tries to read values from
`event.detail.values` but we haven't verified this works yet.

## Key Files Modified

1. `packages/ui/src/v2/components/form-context.ts` - FormContext interface with
   `name` field
2. `packages/ui/src/v2/components/ct-form/ct-form.ts` - Provides context,
   validates, emits values
3. `packages/ui/src/v2/components/ct-input/ct-input.ts` - Buffers writes, syncs
   with cell changes
4. `packages/ui/src/v2/components/ct-select/ct-select.ts` - Same buffering
   pattern
5. `packages/ui/src/v2/components/ct-checkbox/ct-checkbox.ts` - Same buffering
   pattern
6. `packages/ui/src/v2/components/ct-textarea/ct-textarea.ts` - Same buffering
   pattern
7. `packages/ui/src/v2/components/ct-button/ct-button.ts` - Handles submit/reset
   across shadow DOM
8. `packages/patterns/form-demo.tsx` - Demo pattern testing the system

## Next Steps

1. **Test the current state** - Run form-demo and verify:
   - `event.detail.values` contains the form field values
   - Values are keyed by field `name` attribute (name, email, role)
   - Create and edit modes work

2. **If values are coming through**:
   - Clean up debug logging
   - Test edit mode (populate form with existing values)
   - Test cancel (discard buffered changes)

3. **If values still not coming through**:
   - Check what `event.detail` actually contains after serialization
   - May need to stringify/parse the values object

4. **Edit mode concern**:
   - Fields sync buffer when cell changes externally (via `_syncBufferWithCell`)
   - When `formData.set(existingPerson)` is called, fields should pick up new
     values
   - This might need testing/fixing

## Architecture Summary

```
Pattern                          ct-form                     ct-input (and other fields)
-------                          -------                     -------------------------
formData = Writable.of({})  -->  provides FormContext   -->  consumes FormContext
                                                              |
startCreate() sets formData -->  [form renders]         -->  _syncBufferWithCell() updates buffer
                                                              |
user types                  <--                         <--  setValue() updates buffer (not cell)
                                                              |
click submit               -->   submit() called        -->  validates all fields
                                  |                           |
                                  emits ct-submit with    <-- getValue() returns buffer
                                  { values: {name: ..} }
                                  |
handleFormSubmit receives   <--  [serialized event]
event.detail.values
                                  |
people.push(person)              (pattern writes to cells)
```

## Debug Commands

```bash
# Type check
deno check packages/ui/src/v2/components/ct-form/ct-form.ts

# Pattern validation
deno task ct check packages/patterns/form-demo.tsx

# Run dev server (from repo root)
# Then open the form-demo pattern in browser
```

## Commits on this Branch

```
da7976886 fix(ui): emit serializable values object in form submit event
eea2dd423 debug: more detailed event.detail logging
9f05b8c24 debug: log event structure to understand how handlers receive events
7f0a639b1 fix(ui): flush form values within action context for cell writes
9513107da fix(ui): sync form field buffers when cell value changes externally
7465554bb fix(ui): handle form submit/reset across shadow DOM boundaries
ed378de87 debug: add logging to ct-form and form-demo to diagnose submit issue
059bc0ea4 fix(patterns): fix form-demo handler to pass Writable cells correctly
e636f65bb feat(ui): add form buffering for atomic field submissions
```
