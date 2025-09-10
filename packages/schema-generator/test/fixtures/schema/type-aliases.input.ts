interface Cell<T> {
  get(): T;
  set(v: T): void;
}
interface Stream<T> {
  subscribe(cb: (v: T) => void): void;
}
type Default<T, V extends T = T> = T;
type MyCell<T> = Cell<T>;
type MyStream<T> = Stream<T>;
type MyDefault<T, V extends T = T> = Default<T, V>;
interface SchemaRoot {
  a: MyCell<number>;
  b: MyStream<MyCell<string>>;
  c: MyDefault<string, "x">;
}
