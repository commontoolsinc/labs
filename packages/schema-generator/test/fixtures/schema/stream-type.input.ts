interface Stream<T> extends BrandedCell<T, "stream"> {
  subscribe(cb: (v: T) => void): void;
}
interface SchemaRoot {
  s: Stream<string>;
}
