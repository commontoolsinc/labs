interface Cell<T> { get(): T; set(v: T): void; }
type CellArray<T> = Cell<T[]>;
type Alias2<T> = CellArray<T>;
interface SchemaRoot { values: Alias2<number>; }

