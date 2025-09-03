interface Cell<T> { get(): T; set(v: T): void }
interface SchemaRoot {
  v: Cell<number[]>;
  w: Cell<Array<{ id: string }>>;
}

