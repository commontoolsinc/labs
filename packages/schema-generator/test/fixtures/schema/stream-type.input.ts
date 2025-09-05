interface Stream<T> {
  subscribe(cb: (v: T) => void): void;
}
interface SchemaRoot {
  s: Stream<string>;
}
