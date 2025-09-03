interface Cell<T> { get(): T; set(v: T): void; }
interface Stream<T> { subscribe(cb: (v: T) => void): void }
interface SchemaRoot { stream: Stream<Cell<number>> }

