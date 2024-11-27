import { Task } from "synopsys";

export function* wait<T>(request: IDBRequest<T>) {
  if (request.readyState === "done") {
    return request.result;
  }

  const invocation = yield* Task.fork(Task.suspend());
  const resume = () => {
    request.removeEventListener("success", resume);
    request.removeEventListener("error", resume);
    invocation.abort(Task.RESUME);
  };
  request.addEventListener("success", resume);
  request.addEventListener("error", resume);

  try {
    yield* invocation;
  } catch {}

  if (request.error) {
    throw request.error;
  } else {
    return request.result;
  }
}

export type Address = {
  name: string;
  version: number;
  store: string;
};

export function* open<
  Value extends unknown = unknown,
  Key extends IDBValidKey = IDBValidKey,
>(address: Address) {
  const request = indexedDB.open(address.name, address.version);
  const store = address.store;

  request.onupgradeneeded = () => {
    request.result.createObjectStore(store);
  };

  const db = yield* wait(request);

  return new Store<Value, Key>(db, store);
}

export class Store<
  Value extends unknown = unknown,
  Key extends IDBValidKey = IDBValidKey,
> {
  constructor(
    public db: IDBDatabase,
    public name: string,
  ) {}

  *set(key: Key, value: Value) {
    const store = this.db
      .transaction(this.name, "readwrite")
      .objectStore(this.name);
    yield* wait(store.put(value, key));
  }

  *get(key: Key): Task.Task<Value | undefined> {
    const store = this.db
      .transaction(this.name, "readonly")
      .objectStore(this.name);
    return yield* wait(store.get(key));
  }

  *delete(key: Key) {
    const store = this.db
      .transaction(this.name, "readwrite")
      .objectStore(this.name);

    yield* wait(store.delete(key));
  }

  iterator(
    range: IDBKeyRange,
  ): Iterator<IDBCursorWithValue, Key, Value, IDBCursorWithValue> {
    return new Iterator(this.db, this.name, range);
  }

  keys(range: IDBKeyRange): Iterator<Key, Key, Value, IDBCursor> {
    return this.iterator(range).keys();
  }

  values(range: IDBKeyRange) {
    return this.iterator(range).values();
  }

  entries(range: IDBKeyRange) {
    return this.iterator(range).entries();
  }
}

class Iterator<T, Key, Value, Cursor extends IDBCursor | IDBCursorWithValue> {
  #request: IDBRequest<Cursor> | null = null;
  cursor: Cursor | null = null;
  done: boolean = false;

  constructor(
    public db: IDBDatabase,
    public name: string,
    public range: IDBKeyRange,
    public reversed: boolean = false,

    public ok: (cursor: Cursor) => T = cursor => cursor as unknown as T,
    public openCursor: (
      store: IDBObjectStore,
      range: IDBKeyRange,
      direction: IDBCursorDirection,
    ) => IDBRequest<Cursor> = (store, range, direction) =>
      store.openCursor(range, direction) as any,
  ) {}

  get request() {
    if (this.#request) {
      return this.#request;
    } else {
      this.#request = this.openCursor(
        this.db.transaction(this.name, "readonly").objectStore(this.name),
        this.range,
        this.reversed ? "prev" : "next",
      );
      return this.#request;
    }
  }

  reverse(): this {
    return new (this.constructor as typeof Iterator)(
      this.db,
      this.name,
      this.range,
      true,
      this.ok,
      this.openCursor,
    ) as this;
  }
  /**
   * @returns {Task.Task<Type.Result<[key:Uint8Array, value:Uint8Array], Type.IterationFinished>, Error>}
   */
  *next() {
    if (this.done) {
      return { error: new Error("Iteration finished") };
    }

    const { request } = this;

    if (this.cursor != null) {
      this.cursor.continue();
    }
    const cursor = yield* wait(request);
    this.cursor = cursor;
    if (cursor == null) {
      this.done = true;
      return { error: new Error("Iteration finished") };
    } else {
      return { ok: this.ok(cursor) };
    }
  }

  keys() {
    return new Iterator<Key, Key, Value, IDBCursor>(
      this.db,
      this.name,
      this.range,
      this.reversed,
      cursor => cursor.key as Key,
      (store, range, direction) =>
        store.openKeyCursor(range, direction) as IDBRequest<IDBCursor>,
    );
  }

  values() {
    return new Iterator<Value, Key, Value, IDBCursorWithValue>(
      this.db,
      this.name,
      this.range,
      this.reversed,
      cursor => cursor.value,
      (store, range, direction) =>
        store.openCursor(range, direction) as IDBRequest<IDBCursorWithValue>,
    );
  }
  entries() {
    return new Iterator<[Key, Value], Key, Value, IDBCursorWithValue>(
      this.db,
      this.name,
      this.range,
      this.reversed,
      cursor => [cursor.key, cursor.value] as [Key, Value],
      (store, range, direction) =>
        store.openCursor(range, direction) as IDBRequest<IDBCursorWithValue>,
    );
  }
  *first() {
    const { ok } = yield* this.next();
    return ok;
  }

  *take(n: number) {
    const values = [];
    for (let i = 0; i < n; i++) {
      const { ok, error } = yield* this.next();
      if (error) {
        break;
      }
      values.push(ok);
    }
    return values;
  }
}
