type Default<T, V extends T = T> = T;
interface Cell<T> {
  get(): T;
  set(v: T): void;
}
interface SchemaRoot {
  cellOfDefault: Cell<Default<string, "d">>;
  defaultArray: Default<string[], ["a", "b"]>;
}
