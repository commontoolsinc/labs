interface Cell<T> { get(): T; set(v: T): void }
interface Stream<T> { subscribe(cb: (v: T) => void): void }
interface Default<T, V> {}
type MyCell<T> = Cell<T>;
type MyStream<T> = Stream<T>;
type MyDefault<T, V> = Default<T, V>;
interface SchemaRoot {
  a: MyCell<number>;
  b: MyStream<MyCell<string>>;
  c: MyDefault<string, "x">;
}

