import type {
  AsyncStore,
  Merge,
  Result,
  Selection,
  Selector,
} from "./cache.ts";

export interface IDBStoreAddress {
  name: string;
  store: string;
  version: number;
}

export interface IDBStoreFormat<
  Model extends object,
  Address,
  EncodedValue extends object,
  EncodedKey extends IDBValidKey,
> {
  value: Codec<Model, EncodedValue>;
  key: Encoder<Address, EncodedKey>;
  address: Encoder<Model, EncodedKey>;
}

export const open = <
  Model extends object,
  Address,
  EncodedValue extends object,
  EncodedKey extends IDBValidKey,
>(
  address: IDBStoreAddress,
  format: IDBStoreFormat<Model, Address, EncodedValue, EncodedKey>,
): AsyncStore<Model, Address> => Store.open(new Session(address), format);

/**
 * Returns `true` is IDB is supported on the given runtime.
 */
export const available = () =>
  typeof globalThis?.indexedDB?.open === "function";

export const swap = <T extends object>(
  store: IDBObjectStore,
  key: IDBValidKey,
  update: (value: T | undefined) => T | undefined,
): Promise<Result<T | typeof NOT_FOUND, DOMException>> =>
  new Promise((success, fail) => {
    then(
      store.get(key) as IDBRequest<T | undefined>,
      (value) => {
        const next = update(value);
        if (value !== next) {
          then(
            store.put(next, key),
            () => success({ ok: next ?? NOT_FOUND }),
            (error) => fail({ error }),
          );
        } else if (next === undefined) {
          then(
            store.delete(key),
            () => success({ ok: NOT_FOUND }),
            (error) => fail({ error }),
          );
        } else {
          success({ ok: next });
        }
      },
      (error: DOMException) => {
        fail({ error });
      },
    );
  });

export const NOT_FOUND = Symbol("NOT_FOUND");

export const get = <T extends object>(
  store: IDBObjectStore,
  key: IDBValidKey,
): Promise<Result<T | typeof NOT_FOUND, DOMException>> =>
  new Promise((success, fail) => {
    then(
      store.get(key) as IDBRequest<T | undefined>,
      (value) => success({ ok: value ?? NOT_FOUND }),
      (error) => fail({ error }),
    );
  });

const then = <T>(
  request: IDBRequest<T>,
  onsuccess: (value: T) => void,
  onfail: (value: DOMException) => void,
) => {
  if (request.readyState === "done") {
    if (request.error) {
      onfail(request.error);
    } else {
      onsuccess(request.result);
    }
  } else {
    request.addEventListener("success", (event) => onsuccess(request.result), {
      once: true,
    });
    request.addEventListener("error", (event) => onfail(request.error!), {
      once: true,
    });
  }
};

const wait = <T extends object>(
  request: IDBRequest<T>,
): Promise<Result<T, DOMException>> =>
  new Promise((success, fail) =>
    then(request, (ok) => success({ ok }), (error) => fail({ error }))
  );

class StoreError extends Error {
  override name = "StoreError" as const;
  constructor(message: string, override cause: Error) {
    super(message);
  }
}

export interface Encoder<Decoded, Encoded> {
  encode: (value: Decoded) => Encoded;
}

export interface Decoder<Decoded, Encoded> {
  decode: (value: Encoded) => Decoded;
}

export interface Codec<Decoded, Encoded>
  extends Encoder<Decoded, Encoded>, Decoder<Decoded, Encoded> {
}

/**
 * A general interface for working with IndexedDB object store. It only provides
 * a basic transaction interface for reading and writing data in a single
 transaction.
 */
export class Session {
  connection: Promise<Result<IDBDatabase, DOMException>>;
  constructor(public address: IDBStoreAddress) {
    this.upgrade = this.upgrade.bind(this);
    this.connection = this.open();
  }
  open() {
    const request = indexedDB.open(this.address.name, this.address.version);
    request.onupgradeneeded = this.upgrade;
    return this.connection = wait(request);
  }
  upgrade(event: IDBVersionChangeEvent) {
    (event.target as IDBOpenDBRequest).result.createObjectStore(
      this.address.store,
    );
  }

  async transact<Ok extends object, TransactionError extends Error>(
    mode: IDBTransactionMode,
    transact: (store: IDBObjectStore) => Promise<Result<Ok, TransactionError>>,
  ): Promise<Result<Ok, TransactionError | StoreError>> {
    const { ok: session, error } = await this.connection;
    if (session) {
      return transact(
        session.transaction(this.address.store, mode).objectStore(
          this.address.store,
        ),
      );
    } else {
      return { error: new StoreError("Opening database failed", error) };
    }
  }
}

/**
 * An API for working with IndexedDB object store that allows batch reads and
 * batch writes.
 */
export class Store<
  Model extends object,
  Address,
  EncodedValue extends object,
  EncodedKey extends IDBValidKey,
> implements AsyncStore<Model, Address> {
  static open<
    Model extends object,
    Address,
    EncodedValue extends object,
    EncodedKey extends IDBValidKey,
  >(
    session: Session,
    format: IDBStoreFormat<Model, Address, EncodedValue, EncodedKey>,
  ): AsyncStore<Model, Address> {
    return new this<Model, Address, EncodedValue, EncodedKey>(
      session,
      format,
    );
  }
  constructor(
    public session: Session,
    public format: IDBStoreFormat<Model, Address, EncodedValue, EncodedKey>,
  ) {
  }
  /**
   * Loads records from the underlying store and returns a map of records keyed
   * by keys in the provided selector. Entries that did not exist in the store
   * will not be included in the selection.
   */
  pull(
    selector: Selector<Address>,
  ): Promise<Result<Selection<Address, Model>, StoreError>> {
    const { key, value } = this.format;
    return this.session.transact<Selection<Address, Model>, StoreError>(
      "readonly",
      async (store) => {
        const addresses = [...selector];
        const promises = [];
        for (const address of addresses) {
          promises.push(get<EncodedValue>(store, key.encode(address)));
        }

        const results = await Promise.all(promises);
        const selection = new Map();
        for (const [at, { ok, error }] of results.entries()) {
          if (error) {
            return { error: new StoreError("Failed to load", error) };
          } else if (ok !== NOT_FOUND) {
            selection.set(addresses[at], value.decode(ok));
          }
        }

        return { ok: selection };
      },
    );
  }

  merge(
    entries: Iterable<Model>,
    merge: Merge<Model>,
  ): Promise<Result<object, StoreError>> {
    const { key, value, address } = this.format;
    return this.session.transact<object, StoreError>(
      "readwrite",
      async (store) => {
        const promises = [];
        for (const entry of entries) {
          promises.push(swap<EncodedValue>(
            store,
            address.encode(entry),
            (local) => {
              const before = local ? value.decode(local) : undefined;
              const after = merge(before, entry);
              return before === after
                ? local
                : after === undefined
                ? after
                : value.encode(after);
            },
          ));
        }

        const results = await Promise.all(promises);

        for (const result of results) {
          if (result.error) {
            return {
              error: new StoreError(result.error.message, result.error),
            };
          }
        }

        return { ok: {} };
      },
    );
  }
}
