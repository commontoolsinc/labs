# CellController Design Document

## Overview

The `CellController` is a reactive controller for Lit components that provides a
unified interface for handling both plain values and reactive `Cell<T>` objects.
It eliminates boilerplate code by centralizing Cell subscription management,
transaction handling, and timing strategies.

## Problem Statement

Before CellController, each UI component that needed to work with `Cell<T>`
values had to implement:

1. **Subscription Management** (~15 lines per component)
   - `_setupCellSubscription()` method
   - `_cleanupCellSubscription()` method
   - `_cellUnsubscribe` tracking
   - Lifecycle integration (connectedCallback, disconnectedCallback, updated)

2. **Transaction Handling** (~10 lines per component)
   - `runtime.edit()` creation
   - `withTx(tx)` usage
   - `tx.commit()` calls
   - Error handling

3. **Timing Controller Integration** (~15 lines per component)
   - InputTimingController setup
   - Strategy configuration
   - Focus/blur event handling
   - Dynamic option updates

4. **Value Getter/Setter Logic** (~10 lines per component)
   - `isCell()` type checking
   - Safe `.get()` calls with fallbacks
   - Consistent setValue patterns

This resulted in **~50-70 lines of boilerplate per component** with high
duplication and maintenance overhead.

## Solution Design

### Core Architecture

```typescript
class CellController<T> implements ReactiveController {
  // Centralized Cell handling logic
  // Configurable through options
  // Type-safe generic implementation
}
```

### Key Design Decisions

#### 1. Configuration-Driven Approach

Instead of inheritance, we use a configuration object that allows customization
of specific behaviors:

```typescript
interface CellControllerOptions<T> {
  timing?: InputTimingOptions; // Timing strategy config
  getValue?: (value: Cell<T> | T) => T; // Custom value extraction
  setValue?: (value: Cell<T> | T, newValue: T, oldValue: T) => void; // Custom update logic
  onChange?: (newValue: T, oldValue: T) => void; // Change callback
  transactionStrategy?: "auto" | "manual" | "batch"; // Transaction handling
  triggerUpdate?: boolean; // Auto-update host
  onFocus?: () => void; // Focus handling
  onBlur?: () => void; // Blur handling
}
```

This approach provides:

- **Flexibility**: Each component can customize only what it needs
- **Reusability**: Common patterns can be shared
- **Type Safety**: Full TypeScript support with generics
- **Testability**: Easy to mock and test individual behaviors

#### 2. Transaction Strategy Abstraction

Components have different transaction needs:

- **Auto** (default): Create transaction, set value, commit immediately
- **Manual**: Component handles transactions (for complex updates)
- **Batch**: Collect changes and commit in batches (future enhancement)

```typescript
// Auto strategy (most common)
const controller = new CellController(host, {
  transactionStrategy: "auto", // Default
});

// Manual strategy (complex scenarios)
const controller = new CellController(host, {
  transactionStrategy: "manual",
  setValue: (value, newValue, oldValue) => {
    if (isCell(value)) {
      const tx = value.runtime.edit();
      try {
        // Custom validation logic
        if (validateData(newValue)) {
          value.withTx(tx).set(newValue);
          tx.commit();
        }
      } catch (error) {
        // Don't commit on error
      }
    }
  },
});
```

#### 3. Specialized Controllers for Common Patterns

Instead of one monolithic controller, we provide specialized versions:

```typescript
// Base controller - fully configurable
class CellController<T> {/* ... */}

// String-optimized controller
class StringCellController extends CellController<string> {
  // Preconfigured for string handling
  // Default debounce timing
  // Empty string fallbacks
}

// Array-optimized controller
class ArrayCellController<T> extends CellController<T[]> {
  // Preconfigured for array handling
  // Immediate timing
  // Helper methods: addItem, removeItem, updateItem
}
```

#### 4. Timing Controller Integration

Built-in integration with `InputTimingController`:

```typescript
const controller = new CellController(host, {
  timing: {
    strategy: "debounce",
    delay: 300,
  },
});

// Timing is handled automatically:
controller.setValue("new value"); // Debounced
controller.onFocus(); // Passed to timing controller
controller.onBlur(); // Triggers immediate update if needed
```

#### 5. Lifecycle Management

Automatic subscription lifecycle tied to Lit's ReactiveController:

```typescript
// Automatically called by Lit
hostConnected() {
  this._setupCellSubscription();
}

hostDisconnected() {
  this._cleanupCellSubscription();
  this._inputTiming?.cancel();
}
```

## API Design

### Core Methods

```typescript
// Value binding and access
bind(value: Cell<T> | T): void
getValue(): T
setValue(newValue: T): void

// Type checking and Cell access
isCell(): boolean
getCell(): Cell<T> | null

// Timing control
onFocus(): void
onBlur(): void
cancel(): void
updateTimingOptions(options: Partial<InputTimingOptions>): void
```

### Factory Functions

For better ergonomics and type inference:

```typescript
// Generic factory
createCellController<T>(host, options?) => CellController<T>

// Specialized factories
createStringCellController(host, options?) => StringCellController
createArrayCellController<T>(host, options?) => ArrayCellController<T>
```

## Usage Patterns

### 1. Simple Input Component

```typescript
class MyInput extends BaseElement {
  @property()
  value: Cell<string> | string = "";

  private cellController = createStringCellController(this, {
    onChange: (newValue, oldValue) => {
      this.emit("value-changed", { value: newValue, oldValue });
    },
  });

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has("value")) {
      this.cellController.bind(this.value);
    }
  }

  private handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.cellController.setValue(input.value);
  }

  override render() {
    return html`
      <input .value="${this.cellController.getValue()}" @input="${this
        .handleInput}">
    `;
  }
}
```

### 2. List Component

```typescript
class MyList<T> extends BaseElement {
  @property()
  items: Cell<T[]> | T[] = [];

  private cellController = createArrayCellController<T>(this);

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has("items")) {
      this.cellController.bind(this.items);
    }
  }

  private addItem(item: T) {
    this.cellController.addItem(item);
  }

  private removeItem(item: T) {
    this.cellController.removeItem(item);
  }

  override render() {
    const items = this.cellController.getValue();
    return html`
      /* render items */
    `;
  }
}
```

### 3. Advanced Custom Logic

```typescript
class ComplexEditor extends BaseElement {
  private cellController = new CellController<ComplexData>(this, {
    timing: { strategy: "blur" },
    transactionStrategy: "manual",
    setValue: (value, newValue, oldValue) => {
      // Custom validation and transaction logic
      if (this.validate(newValue)) {
        this.performComplexUpdate(value, newValue);
      }
    },
    onChange: (newValue, oldValue) => {
      this.updateUI(newValue);
      this.emit("data-changed", { newValue, oldValue });
    },
  });
}
```

## Benefits

### Code Reduction

- **70% less boilerplate** per component
- **Consistent patterns** across all Cell-using components
- **Fewer bugs** due to centralized logic

### Maintainability

- **Single source of truth** for Cell handling
- **Easy to update** Cell behavior across all components
- **Better testing** through focused unit tests

### Type Safety

- **Full TypeScript support** with generics
- **Compile-time checking** for value types
- **IDE autocompletion** for all methods

### Flexibility

- **Highly configurable** through options
- **Custom logic** support for complex scenarios
- **Multiple strategies** for different use cases

## Migration Guide

### From Manual Cell Handling

**Before:**

```typescript
class OldComponent extends BaseElement {
  private _cellUnsubscribe: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._setupCellSubscription();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupCellSubscription();
  }

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has("value")) {
      this._cleanupCellSubscription();
      this._setupCellSubscription();
    }
  }

  private _setupCellSubscription(): void {
    if (isCell(this.value)) {
      this._cellUnsubscribe = this.value.sink(() => {
        this.requestUpdate();
      });
    }
  }

  private _cleanupCellSubscription(): void {
    if (this._cellUnsubscribe) {
      this._cellUnsubscribe();
      this._cellUnsubscribe = null;
    }
  }

  private getValue(): string {
    if (isCell(this.value)) {
      return this.value.get?.() || "";
    }
    return this.value || "";
  }

  private setValue(newValue: string): void {
    if (isCell(this.value)) {
      const tx = this.value.runtime.edit();
      this.value.withTx(tx).set(newValue);
      tx.commit();
    } else {
      this.value = newValue;
    }
  }
}
```

**After:**

```typescript
class NewComponent extends BaseElement {
  private cellController = createStringCellController(this);

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has("value")) {
      this.cellController.bind(this.value);
    }
  }

  private handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.cellController.setValue(input.value);
  }

  override render() {
    return html`
      <input .value="${this.cellController.getValue()}" @input="${this
        .handleInput}">
    `;
  }
}
```

### Migration Steps

1. **Replace subscription management** with `cellController.bind()`
2. **Replace getValue/setValue** with `cellController.getValue()/setValue()`
3. **Remove lifecycle methods** (handled automatically)
4. **Configure timing** through controller options
5. **Add custom logic** through onChange callback

## Testing Strategy

### Unit Tests

- **Mock Cell implementation** for isolated testing
- **Mock Lit host** for controller lifecycle testing
- **Test all configuration options** independently
- **Test error conditions** and edge cases

### Integration Tests

- **Real Lit components** using CellController
- **Actual Cell instances** from runner
- **End-to-end workflows** with timing and transactions

### Performance Tests

- **Memory leak detection** for subscription cleanup
- **Performance comparison** vs manual implementation
- **Stress testing** with rapid value changes

## Future Enhancements

### Batch Transaction Strategy

```typescript
const controller = new CellController(host, {
  transactionStrategy: "batch",
  batchWindow: 100, // ms
});

// Multiple setValue calls batched into single transaction
controller.setValue("value1");
controller.setValue("value2");
controller.setValue("value3");
// -> Single transaction with final value
```

### Validation Integration

```typescript
const controller = new CellController(host, {
  validate: (value) => value.length > 0,
  onValidationError: (error) => this.showError(error),
});
```

### Undo/Redo Support

```typescript
const controller = new CellController(host, {
  enableHistory: true,
  historySize: 10,
});

controller.undo();
controller.redo();
```

### Schema Integration

```typescript
const controller = new CellController(host, {
  schema: myJSONSchema,
  autoValidate: true,
});
```

## Conclusion

The CellController design provides a robust, flexible, and type-safe solution
for Cell integration in Lit components. It eliminates boilerplate, centralizes
logic, and provides a foundation for future enhancements while maintaining
backward compatibility and supporting complex use cases through configuration.
