// Test to verify the component can be imported correctly
import { CTCellTester } from "../../index.ts";
import { createSimpleCell } from "../ct-outliner/simple-cell.ts";

// Test basic instantiation
const tester = new CTCellTester();
console.log("CTCellTester instantiated successfully");

// Test with a cell
const cell = createSimpleCell(42);
tester.cell = cell;
console.log("Cell set successfully, current value:", cell.get());

// Test cell update
cell.set(100);
console.log("Cell updated, new value:", cell.get());

console.log("All imports and basic functionality work correctly!");