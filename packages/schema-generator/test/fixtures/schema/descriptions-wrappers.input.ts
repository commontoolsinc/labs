type Default<T, V extends T = T> = T;
interface Cell<T> extends BrandedCell<T, "cell"> {
  get(): T;
  set(v: T): void;
}
interface Stream<T> extends BrandedCell<T, "stream"> {
  subscribe(cb: (v: T) => void): void;
}

interface SchemaRoot {
  /** Titles in a cell */
  titles: Cell<string[]>;
  /** Count as stream */
  count: Stream<number>;
  /** Level with default */
  level: Default<number, 3>;
}
