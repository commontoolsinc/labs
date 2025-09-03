/// <cts-enable />
import { Cell, Stream, Default, toSchema, recipe } from "commontools";

// Test nested wrapper types

// Default wrapping Cell - these don't work because Default<T, V> requires V extends T
// and a literal value doesn't extend Cell<T>
interface DefaultCell {
  field1: Default<string, "hello">;
  field2: Default<number, 42>;
}

const defaultCellSchema = toSchema<DefaultCell>();

// Cell wrapping Default
interface CellOfDefault {
  value: Cell<Default<string, "default">>;
}

const cellOfDefaultSchema = toSchema<CellOfDefault>();

// Stream wrapping Default  
interface StreamOfDefault {
  events: Stream<Default<string, "initial">>;
}

const streamOfDefaultSchema = toSchema<StreamOfDefault>();

// Array of Cells
interface ArrayOfCells {
  items: Cell<string>[];
}

const arrayOfCellsSchema = toSchema<ArrayOfCells>();

// Cell containing array
interface CellOfArray {
  tags: Cell<string[]>;
}

const cellOfArraySchema = toSchema<CellOfArray>();

// Complex nesting
interface ComplexNesting {
  // Cell containing Default
  cellOfDefault: Cell<Default<string, "default">>;
  
  // Default containing array
  defaultArray: Default<string[], ["a", "b"]>;
}

const complexNestingSchema = toSchema<ComplexNesting>();

export {
  defaultCellSchema,
  cellOfDefaultSchema,
  streamOfDefaultSchema,
  arrayOfCellsSchema,
  cellOfArraySchema,
  complexNestingSchema
};

// Add a recipe export for ct dev testing
export default recipe("Nested Wrappers Test", () => {
  return {
    schema: defaultCellSchema,
  };
});
