# @cell() Decorator Implementation Summary

## Overview

Successfully implemented the foundation for the `@cell()` decorator for Linear issue CT-714. This decorator simplifies Cell<T> integration with Lit components by automatically managing subscriptions, timing strategies, and reactive updates.

## Key Design Decisions

### 1. Cell<T> Only Support
- **Decision**: The decorator ONLY supports `Cell<T>` properties, not `Cell<T> | T` unions
- **Rationale**: Simplifies implementation significantly while maintaining type safety
- **Impact**: Cleaner codebase, easier to maintain, less ambiguous behavior

### 2. Composition with @property()
- **Implementation**: The `@cell()` decorator calls Lit's `@property()` decorator internally
- **Pattern**: Follows the same pattern as Lit's `@state()` decorator
- **Benefits**: Inherits all Lit property functionality while adding Cell-specific behavior

### 3. WeakMap-based Subscription Management
- **Architecture**: Uses WeakMaps to avoid requiring a base class
- **Memory Safety**: Automatic cleanup when elements are garbage collected
- **Isolation**: Each element instance has its own subscription tracking

## Files Created

### 1. `/packages/ui/src/v2/core/cell-decorator-types.ts`
- Defines `CellDecoratorOptions` interface
- Exports timing strategy types
- Provides decorator function type signature
- Internal metadata types for subscription tracking

### 2. `/packages/ui/src/v2/core/cell-decorator.ts`
- Main decorator implementation
- Subscription management using WeakMaps
- Custom converter for Cell<T> to attribute conversion
- Cell identity-based change detection
- Integration with InputTimingController
- Utility function `setCellValue()` for components

### 3. `/packages/ui/src/v2/core/cell-decorator.test.ts`
- Basic functionality tests
- Type checking verification
- Export validation

### 4. `/packages/ui/src/v2/core/cell-decorator-example.ts`
- Complete working example component
- Demonstrates all timing strategies
- Shows proper usage patterns
- Includes comprehensive documentation

## Core Features Implemented

### 1. Automatic Subscription Management
- Subscribes to Cell changes when Cell is assigned to property
- Unsubscribes when Cell changes or element disconnects
- Triggers `requestUpdate()` when Cell values change
- No manual subscription handling required

### 2. Timing Strategy Integration
- Supports all InputTimingController strategies:
  - `immediate`: Updates happen right away
  - `debounce`: Delays updates (good for text input)
  - `throttle`: Limits update frequency
  - `blur`: Only updates on blur events

### 3. Cell-Aware Property Conversion
- Custom converter extracts `cell.get()` for attribute reflection
- Identity-based change detection (different Cells trigger updates)
- Handles null/undefined Cells gracefully

### 4. Transaction Management
- `setCellValue()` utility handles transactions automatically
- Integrates with timing controllers for delayed commits
- Follows Cell's transaction patterns consistently

## Usage Example

```typescript
import { customElement } from "lit/decorators.js";
import { BaseElement } from "@commontools/ui/v2/core";
import { cell, setCellValue } from "@commontools/ui/v2/core";

@customElement("my-input")
export class MyInput extends BaseElement {
  @cell({ timing: { strategy: "debounce", delay: 300 } })
  value: Cell<string> | undefined;

  private handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    setCellValue(this, 'value', input.value);
  }

  render() {
    return html`
      <input 
        .value="${this.value?.get?.() || ''}"
        @input="${this.handleInput}"
      />
    `;
  }
}
```

## Technical Implementation Details

### Subscription Tracking
```typescript
const cellSubscriptions = new WeakMap<ReactiveElement, Map<PropertyKey, () => void>>();
```

### Timing Integration
```typescript
const cellTimingControllers = new WeakMap<ReactiveElement, Map<PropertyKey, InputTimingController>>();
```

### Lifecycle Management
- Hooks into `ReactiveElement.prototype.disconnectedCallback`
- Ensures all subscriptions are cleaned up when elements disconnect
- Preserves original Lit lifecycle behavior

## Integration with Existing Codebase

### Exports Added to `packages/ui/src/v2/core/index.ts`:
```typescript
export { cell, setCellValue } from "./cell-decorator.ts";
export type { 
  CellDecoratorOptions, 
  CellDecorator,
  InputTimingOptions,
  InputTimingStrategy 
} from "./cell-decorator-types.ts";
```

### Available through main v2 exports:
```typescript
import { cell, setCellValue } from "@commontools/ui/v2";
```

## Testing Status

- ✅ Basic decorator functionality tests
- ✅ Type checking validation
- ✅ Export verification
- ✅ Example component compilation
- ✅ Full v2 module type checking

## Next Steps for Full Implementation

1. **Integration Testing**: Test with actual Cell instances and runtime
2. **Component Migration**: Update existing components to use @cell()
3. **Advanced Features**: Consider schema integration, validation hooks
4. **Performance Testing**: Benchmark subscription overhead
5. **Documentation**: Add to component library docs
6. **Edge Cases**: Handle complex scenarios (arrays of Cells, nested Cells)

## Benefits Achieved

1. **Simplified API**: No manual subscription management
2. **Type Safety**: Full TypeScript support with proper generics
3. **Consistent Patterns**: Follows Lit conventions
4. **Memory Safety**: WeakMap-based cleanup
5. **Timing Control**: Flexible update strategies
6. **Composability**: Works with existing Lit features

The foundation is now in place for simplified Cell<T> integration across the component library.