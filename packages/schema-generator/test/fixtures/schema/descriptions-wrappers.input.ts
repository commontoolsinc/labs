type Default<T, V extends T = T> = T;
interface Cell<T> { get(): T; set(v: T): void }
interface Stream<T> { subscribe(cb: (v: T) => void): void }

interface SchemaRoot {
  /** Titles in a cell */
  titles: Cell<string[]>;
  /** Count as stream */
  count: Stream<number>;
  /** Level with default */
  level: Default<number, 3>;
}
