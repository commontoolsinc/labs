/// <cts-enable />
import { Cell, Stream, Default, toSchema } from "commontools";

// Type aliases for Cell
type MyCell<T> = Cell<T>;
type StringCell = Cell<string>;
type NumberCell = Cell<number>;

// Type aliases for Stream
type MyStream<T> = Stream<T>;
type EventStream = Stream<{ type: string; data: any }>;

// Note: Default type aliases are not currently supported
// type WithDefault<T, V> = Default<T, V>;

// Complex type aliases
type CellArray<T> = Cell<T[]>;
type StreamOfCells<T> = Stream<Cell<T>>;

interface TypeAliasTest {
  // Basic type aliases
  genericCell: MyCell<string>;
  specificCell: StringCell;
  numberCell: NumberCell;
  
  // Arrays of type aliases
  cellArray: MyCell<boolean>[];
  stringCells: StringCell[];
  
  // Stream aliases
  genericStream: MyStream<number>;
  eventStream: EventStream;
  
  // Direct Default (aliases not supported)
  withDefault: Default<string, "hello">;
  
  // Complex aliases
  cellOfArray: CellArray<number>;
  streamOfCells: StreamOfCells<string>;
  
  // Nested arrays
  nestedAlias: MyCell<MyCell<string>[]>[];
}

const schema = toSchema<TypeAliasTest>();

export { schema };