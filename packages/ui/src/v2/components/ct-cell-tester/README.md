# CTCellTester Component

A simple debugging component for testing cell operations in the UI.

## Overview

The `ct-cell-tester` component provides a minimal interface for testing `Cell<any>` objects. It displays the current value of a cell and provides a button to set a random number, making it useful for debugging cell reactivity and updates.

## Usage

```typescript
import { CTCellTester } from "@commontools/ui/v2";
import { createSimpleCell } from "@commontools/ui/v2";

// Create a cell with an initial value
const cell = createSimpleCell(42);

// Use in HTML
<ct-cell-tester .cell=${cell}></ct-cell-tester>
```

## Properties

- `cell: Cell<any>` - The cell to test with. When provided, the component will display its current value and allow setting random numbers.

## Features

- **Value Display**: Shows the current value of the cell
- **Random Value Generation**: Click the button to set a random number (0-999)
- **Disabled State**: When no cell is provided, the button is disabled
- **Reactive Updates**: The display updates when the cell value changes

## Example

```html
<ct-cell-tester id="tester"></ct-cell-tester>

<script type="module">
  import { CTCellTester, createSimpleCell } from "@commontools/ui/v2";
  
  const cell = createSimpleCell(0);
  const tester = document.getElementById("tester");
  tester.cell = cell;
  
  // The component will now display "0" and allow setting random numbers
</script>
```

## Use Cases

- **Debugging**: Test cell reactivity and updates
- **Development**: Verify that cells are working correctly
- **Testing**: Simple component for reproducing cell-related bugs
- **Prototyping**: Quick way to test cell behavior in isolation

## Notes

- This component is intended for debugging and development purposes
- It follows the same patterns as other components in the UI package
- The component is ultra-simple by design for focused testing