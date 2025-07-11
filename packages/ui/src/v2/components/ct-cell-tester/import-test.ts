// Test to verify the component can be imported correctly
import { CTCellTester } from "../../index.ts";
import { createSimpleCell } from "../ct-outliner/simple-cell.ts";

// Test basic instantiation
const tester = new CTCellTester();
console.log("CTCellTester instantiated successfully");

// Test with a cell
const testCell = createSimpleCell(42);
tester.cell = testCell;
console.log("Cell set successfully, current value:", testCell.get());

// Test cell update
testCell.set(100);
console.log("Cell updated, new value:", testCell.get());

console.log("All imports and basic functionality work correctly!");