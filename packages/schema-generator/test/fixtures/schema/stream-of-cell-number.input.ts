interface Cell<T> extends BrandedCell<T, "cell"> {
  get(): T;
  set(v: T): void;
}
interface Stream<T> extends BrandedCell<T, "stream"> {
  subscribe(cb: (v: T) => void): void;
}
interface SchemaRoot {
  stream: Stream<Cell<number>>;
}
