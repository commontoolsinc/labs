interface Cell<T> extends BrandedCell<T, "cell"> {
  get(): T;
  set(v: T): void;
}
interface SchemaRoot {
  items: Cell<string>[];
}
