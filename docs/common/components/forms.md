# Form Components

This document describes the form component system in Common Fabric UI, which
provides a "write gate" pattern for transactional form submissions.

## Overview

The form system enables modal forms where:

- Fields buffer writes locally instead of immediately writing to cells
- On submit, all buffered values are validated and flushed atomically
- On cancel/reset, buffered changes are discarded (original cell values
  preserved)
- Works seamlessly for both "create" (fresh cell) and "edit" (existing cell)
  modes

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ cf-form (provides FormContext)                              │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ cf-input    │  │ cf-select   │  │ cf-checkbox │         │
│  │             │  │             │  │             │         │
│  │ FormField   │  │ FormField   │  │ FormField   │         │
│  │ Controller  │  │ Controller  │  │ Controller  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│        │                │                │                  │
│        └────────────────┼────────────────┘                  │
│                         │                                   │
│               registerField() / getValue()                  │
│                         │                                   │
│                    ┌────▼────┐                              │
│                    │ submit  │ → validate all → flush all   │
│                    └─────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### cf-form

The form wrapper that coordinates field buffering and validation.

```tsx
<cf-form oncf-submit={handleSubmit}>
  <cf-input name="email" $value={data.key("email")} required />
  <cf-button type="submit">Save</cf-button>
</cf-form>
```

**Key behaviors:**

- Provides `FormContext` to descendant fields via Lit context
- On submit: validates all fields, flushes buffers to bound cells, emits `cf-submit`
- On reset: restores all fields to their initial cell values
- Handlers close over the bound cell and read from it directly (type-safe)

### Form Fields

All form-compatible fields (cf-input, cf-select, cf-checkbox, cf-textarea) share
the same behavior:

**Outside cf-form:** Writes to bound cell immediately (existing behavior)

**Inside cf-form:** Buffers writes locally until form submits

## Usage Patterns

### Create Mode

Bind fields to a staging cell, then copy to collection on submit:

```tsx
const formData = Writable.of({ name: "", email: "" });

<cf-form
  oncf-submit={handler((_, { formData, collection }) => {
    // cf-form flushes buffers to cells before emitting cf-submit,
    // so we can read the complete, typed object directly.
    // IMPORTANT: Copy the object to avoid sharing references!
    collection.push({ ...formData.get() });
  }, { formData, collection })}
>
  <cf-input name="name" $value={formData.key("name")} required />
  <cf-input name="email" $value={formData.key("email")} type="email" />
  <cf-button type="submit">Create</cf-button>
</cf-form>;
```

### Edit Mode

Bind fields to a pointer (`Writable<Person>`) instead of using indices. On submit,
values are flushed to the bound cell:

```tsx
export const EditPerson = pattern<{ person: Writable<Person> }, { [UI]: VNode }>(
  ({ person }) => ({
    [UI]: (
      <cf-form oncf-submit={closeModal}>
        <cf-input name="name" $value={person.key("name")} required />
        <cf-input name="email" $value={person.key("email")} type="email" />
        <cf-button type="submit">Save</cf-button>
        <cf-button type="reset">Cancel</cf-button>
      </cf-form>
    ),
  }),
);
```

When choosing which item to edit from a list, store the pointer and use
`equals()` for identity-based updates:

```tsx
const editing = Writable.of<{ editing: Person | null }>({ editing: null });

const startEdit = handler((_, { person, editing }) => {
  editing.set({ editing: person });
}, { person, editing });

const handleSubmit = handler((_, { formData, people, editing }) => {
  const next = { ...formData.get() };
  const target = editing.get().editing;
  if (target === null) return;
  const list = people.get();
  const index = list.findIndex((p) => equals(p, target));
  if (index >= 0) {
    const updated = [...list];
    updated[index] = next;
    people.set(updated);
  }
}, { formData, people, editing });
```

### Modal Form Pattern

Common pattern combining create/edit in a modal:

```tsx
const showModal = Writable.of(false);
const editing = Writable.of<{ editing: Person | null }>({ editing: null });
const formData = Writable.of<Person>({ name: "", email: "", role: "user" });

// Open for create
const startCreate = action(() => {
  formData.set({ name: "", email: "", role: "user" });
  editing.set({ editing: null });
  showModal.set(true);
});

// Open for edit - copy existing data into formData (identity-based)
const startEdit = handler((_, { person, people, formData, editing, showModal }) => {
  const current = people.get();
  const index = current.findIndex((p) => equals(p, person));
  if (index < 0) return;
  const target = current[index];
  if (!target) return;
  formData.set({ ...person });
  editing.set({ editing: person });
  showModal.set(true);
}, { person, people, formData, editing, showModal });

// Handle submit - read from formData cell directly (type-safe!)
// IMPORTANT: Create a copy to avoid sharing object references
const handleSubmit = handler((_, { formData, people, editing, showModal }) => {
  const next: Person = { ...formData.get() };  // Copy the object!
  const target = editing.get().editing;
  if (target === null) {
    // Create mode - add new
    people.push(next);
  } else {
    // Edit mode - update existing by identity
    const list = people.get();
    const index = list.findIndex((p) => equals(p, target));
    if (index >= 0) {
      const updated = [...list];
      updated[index] = next;
      people.set(updated);
    }
  }

  showModal.set(false);
  editing.set({ editing: null });
}, { formData, people, editing, showModal });
```

**Important:** Always copy the object with `{ ...formData.get() }` when adding to a
collection. The staging cell (`formData`) is reused between submissions, so pushing
the same object reference would cause all items to share the same data.

## Best Practices

- Prefer identity-based updates for lists: use `equals()` to find and update/remove
  items rather than relying on indices, which can drift when lists change.
- Use a staging cell for create/edit flows and copy on submit to avoid shared references.
- When using `cf-modal`, bind `$open` to a `Writable<boolean>` (not a `computed`)
  so the modal can update state correctly.
- Use `cf-button type="reset"` (or call `form.reset()`) to discard buffered changes.

## Creating Form-Compatible Components

To make a custom component work with cf-form, use `FormFieldController`:

```typescript
import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import { createFormFieldController } from "../../core/form-field-controller.ts";

export class MyCustomInput extends BaseElement {
  // 1. Create a cell controller for the value
  private _cellController = createStringCellController(this, {
    timing: { strategy: "debounce", delay: 300 },
  });

  // 2. Create a form field controller that wraps the cell controller
  private _formField = createFormFieldController<string>(this, {
    cellController: this._cellController,
    validate: () => ({
      valid: this.checkValidity(),
      message: this.validationMessage,
    }),
  });

  // 3. Use formField for getValue/setValue
  private getValue(): string {
    return this._formField.getValue();
  }

  private setValue(value: string): void {
    this._formField.setValue(value);
  }

  // 4. Register with form in firstUpdated (after cell binding)
  override firstUpdated() {
    this._cellController.bind(this.value, stringSchema);
    this._formField.register(this.name); // Pass field name for form submission
  }

  // 5. Cleanup is automatic via ReactiveController
}
```

### FormFieldController API

```typescript
interface FormFieldControllerOptions<T> {
  // The cell controller managing the underlying reactive value
  cellController: CellControllerLike<T>;

  // Validation function for this field (called before form submit)
  validate?: () => ValidationResult;
}

class FormFieldController<T> {
  // Get value (returns buffer if in form, else cell value)
  getValue(): T;

  // Set value (buffers if in form, else writes to cell)
  setValue(value: T): void;

  // Register with form (call in firstUpdated after cell binding)
  register(name?: string): void;

  // Check if this field is inside a cf-form
  inFormContext: boolean;
}
```

## File Organization

```
packages/ui/src/v2/
├── core/
│   ├── cell-controller.ts      # Cell reactivity
│   └── form-field-controller.ts # Form buffering abstraction
│
└── components/
    └── form/
        ├── form-context.ts     # FormContext interface
        ├── cf-form.ts          # Form element
        └── index.ts            # Exports
```

## Key Design Decisions

### Why buffer instead of draft cells?

Simpler implementation. Each field manages a plain value buffer rather than
creating temporary cell structures. The cell system handles reactivity; the form
system just gates when writes flush.

### Why FormFieldController instead of a mixin?

Controllers compose better with existing architecture. Components already use
CellController; FormFieldController layers on top without inheritance complexity.

### Why deferred buffer initialization?

Avoids race conditions. Cell updates are batched, so reading the cell value
during component initialization may return stale data. By deferring buffer
initialization and falling back to cell value, edit mode works correctly.

## Events

### cf-submit

Emitted when form is submitted and all fields are valid. Before emitting this
event, cf-form flushes all buffered field values to their bound cells.

**Important:** Handlers should read from the bound cell directly, not from event
detail. This provides type safety and avoids manual object reconstruction.

```tsx
// ✅ Recommended: close over the cell and read from it
const handleSubmit = handler((_, { formData, collection }) => {
  // Copy the object to avoid sharing references across collection items
  const person = { ...formData.get() };  // Type: Person
  collection.push(person);
}, { formData, collection });
```

### cf-form-invalid

Emitted when submit is attempted but validation fails.

```typescript
interface CFFormInvalidEvent {
  detail: {
    errors: Array<{
      element: HTMLElement;
      message?: string;
    }>;
  };
}
```

## Validation

Fields use HTML5 constraint validation by default. Custom validation can be
provided via the `validate` option in FormFieldController:

```typescript
private _formField = createFormFieldController<string>(this, {
  cellController: this._cellController,
  validate: () => {
    // Custom validation logic
    if (this.getValue().length < 3) {
      return { valid: false, message: "Must be at least 3 characters" };
    }
    return { valid: true };
  },
});
```
