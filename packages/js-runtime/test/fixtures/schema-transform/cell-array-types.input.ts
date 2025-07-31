/// <cts-enable />
import { recipe, Cell, Stream, toSchema } from "commontools";

// Test Cell<any>[]
interface CellAnyArray {
  items: Cell<any>[];
}

const cellAnyArraySchema = toSchema<CellAnyArray>();

// Test Cell<string>[]
interface CellStringArray {
  values: Cell<string>[];
}

const cellStringArraySchema = toSchema<CellStringArray>();

// Test Cell<{ text: string }>[]
interface ComplexCellArray {
  cells: Cell<{ text: string; id: number }>[];
}

const complexCellArraySchema = toSchema<ComplexCellArray>();

// Test Cell<string[]> (Cell containing an array)
interface CellContainingArray {
  tags: Cell<string[]>;
}

const cellContainingArraySchema = toSchema<CellContainingArray>();

// Test Cell<{ items: string[] }[]> (Cell containing array of objects)
interface CellComplexArray {
  data: Cell<{ items: string[]; count: number }[]>;
}

const cellComplexArraySchema = toSchema<CellComplexArray>();

// Test mixed types with Stream<T>[]
interface MixedArrayTypes {
  cells: Cell<string>[];
  streams: Stream<number>[];
  regularArray: string[];
  nestedCell: Cell<Cell<string>[]>;
}

const mixedArrayTypesSchema = toSchema<MixedArrayTypes>();

// Test optional Cell arrays
interface OptionalCellArrays {
  requiredCells: Cell<string>[];
  optionalCells?: Cell<number>[];
}

const optionalCellArraysSchema = toSchema<OptionalCellArrays>();

export {
  cellAnyArraySchema,
  cellStringArraySchema,
  complexCellArraySchema,
  cellContainingArraySchema,
  cellComplexArraySchema,
  mixedArrayTypesSchema,
  optionalCellArraysSchema
};

export default recipe("cell-array-test", () => {
  return {
    cellAnyArraySchema,
    cellStringArraySchema,
    complexCellArraySchema,
    cellContainingArraySchema,
    cellComplexArraySchema,
    mixedArrayTypesSchema,
    optionalCellArraysSchema
  };
});