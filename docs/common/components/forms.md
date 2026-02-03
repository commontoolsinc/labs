# Form Components

This document describes the form component system in Common Tools UI, which
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
│ ct-form (provides FormContext)                              │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ ct-input    │  │ ct-select   │  │ ct-checkbox │         │
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

### ct-form

The form wrapper that coordinates field buffering and validation.

```tsx
<ct-form onct-submit={handleSubmit}>
  <ct-input name="email" $value={data.key("email")} required />
  <ct-button type="submit">Save</ct-button>
</ct-form>
```

**Key behaviors:**

- Provides `FormContext` to descendant fields via Lit context
- On submit: validates all fields, collects values, emits `ct-submit` event
- On reset: restores all fields to their initial cell values
- Emits serializable `{ values: { fieldName: value } }` in event detail

### Form Fields

All form-compatible fields (ct-input, ct-select, ct-checkbox, ct-textarea) share
the same behavior:

**Outside ct-form:** Writes to bound cell immediately (existing behavior)

**Inside ct-form:** Buffers writes locally until form submits

## Usage Patterns

### Create Mode

Bind fields to a fresh cell, then handle the values on submit:

```tsx
const formData = Writable.of({ name: "", email: "" });

<ct-form
  onct-submit={handler((event, { formData }) => {
    const values = event.detail.values;
    // values = { name: "...", email: "..." }
    collection.push(values);
  }, { formData })}
>
  <ct-input name="name" $value={formData.key("name")} required />
  <ct-input name="email" $value={formData.key("email")} type="email" />
  <ct-button type="submit">Create</ct-button>
</ct-form>;
```

### Edit Mode

Bind fields to an existing cell. On submit, values are flushed to the cell:

```tsx
const existingPerson = people.key(selectedIndex);

<ct-form onct-submit={closeModal}>
  <ct-input name="name" $value={existingPerson.key("name")} required />
  <ct-input name="email" $value={existingPerson.key("email")} type="email" />
  <ct-button type="submit">Save</ct-button>
  <ct-button type="reset">Cancel</ct-button>
</ct-form>;
```

### Modal Form Pattern

Common pattern combining create/edit in a modal:

```tsx
const showModal = Writable.of(false);
const editingIndex = Writable.of<number | null>(null);
const formData = Writable.of({ name: "", email: "" });

// Open for create
const startCreate = action(() => {
  formData.set({ name: "", email: "" });
  editingIndex.set(null);
  showModal.set(true);
});

// Open for edit
const startEdit = handler((_, { index, people, formData, editingIndex }) => {
  const person = people.get()[index];
  formData.set({ ...person });
  editingIndex.set(index);
  showModal.set(true);
}, { index, people, formData, editingIndex, showModal });

// Handle submit
const handleSubmit = handler((event, { people, editingIndex, showModal }) => {
  const values = event.detail.values;
  const idx = editingIndex.get();

  if (idx !== null) {
    // Edit mode - update existing
    const list = people.get();
    list[idx] = values;
    people.set([...list]);
  } else {
    // Create mode - add new
    people.push(values);
  }

  showModal.set(false);
}, { people, editingIndex, showModal });
```

## Creating Form-Compatible Components

To make a custom component work with ct-form, use `FormFieldController`:

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

  // Check if this field is inside a ct-form
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
        ├── ct-form.ts          # Form element
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

### ct-submit

Emitted when form is submitted and all fields are valid.

```typescript
interface CTSubmitEvent {
  detail: {
    values: Record<string, unknown>; // { fieldName: value }
    data: Record<string, unknown>; // Native FormData as object
  };
}
```

**Important:** Event detail is JSON-serializable (no DOM elements or functions)
because Common Tools serializes events across worker boundaries.

### ct-form-invalid

Emitted when submit is attempted but validation fails.

```typescript
interface CTFormInvalidEvent {
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
