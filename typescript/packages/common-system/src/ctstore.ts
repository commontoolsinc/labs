import {
  Type,
  Task,
} from "synopsys";
import init, { CTStore } from "@commontools/common-engine";

// This isn't exported from "synopsis/store/sequence"
//import { IterationFinished } from "synopsys/store/sequence";
class CTStoreIterationFinished implements Type.IterationFinished {
  name: 'IterationFinished';
  message = 'IterationFinished';
}

let READ = 0;
let ENTRIES = 0;

class CTStoreSequence implements Type.Sequence<Type.Entry> {
  private index: number;
  private entries: Type.Entry[];
  private store: CTStore;
  private lowerBound: Type.Bound<Type.Key>;
  private upperBound: Type.Bound<Type.Key>;

  constructor(store: CTStore, lowerBound: Type.Bound<Type.Key>, upperBound: Type.Bound<Type.Key>) {
    if (!lowerBound.key || !upperBound.key) {
      throw new Error("Null bounds not yet supported.");
    }
    upperBound.key = padKey(upperBound.key);
    lowerBound.key = padKey(lowerBound.key);
    this.index = 0;
    this.entries = [];
    this.store = store;
    this.upperBound = upperBound;
    this.lowerBound = lowerBound;
  }

  *next(): Type.API.Task<Type.API.Result<Type.Entry, Type.IterationFinished>, Error, typeof Task.SUSPEND | Task.Join | Task.Throw<Error>> {
    if (this.index === 0) {
      if (!this.lowerBound.key || !this.upperBound.key) {
        throw new Error("Null bounds not yet supported.");
      }
      let entries = this.entries;
      yield* Task.wait(this.store.getRange(this.lowerBound.key, this.upperBound.key, this.lowerBound.inclusive, this.upperBound.inclusive, (key: Uint8Array, value: Uint8Array) => {
        entries.push([key, value]);
      }));
    }
    if (this.index < this.entries.length) {
      return { ok: this.entries[this.index++] };
    } else {
      return { error: new CTStoreIterationFinished() };
    }
  }
}

export function* open(dbName: string, tableName: string) {
  yield* Task.wait(init());
  let store = yield* Task.wait(new CTStore(dbName, tableName, undefined));
  return new CTSynopsisStore(store);
}

export class CTSynopsisStore implements Type.Store, Type.StoreReader, Type.StoreWriter {
  private store: CTStore;
  constructor(store: CTStore) {
    this.store = store;
  }

  // /!\ Should be unnecessary
  *getRoot(): Type.API.Task<Type.Node, Error> {
    let key = new Uint8Array(96);
    let hash = this.store.hash() ?? new Uint8Array(32);
    return {
      level: 0,
      key,
      hash,
      value: undefined,
    };
  }

  // /!\ Should be unnecessary
  *getChildren(_level: number, _key: Uint8Array): Type.API.Task<Type.Node[], Error> {
    throw new Error("getChildren() not implemented");
  }
  // /!\ Should be unnecessary
  *getNode(_level: number, _key: Type.Key): Type.API.Task<Type.Node | null, Error> {
    throw new Error("getNode() not implemented");
  }
  // /!\ Should be unnecessary
  nodes(_level: number, _lowerBound?: Type.Bound<Type.Key> | null, _upperBound?: Type.Bound<Type.Key> | null, _options?: { reverse?: boolean; }):
    Type.Sequence<Type.Node> {
    throw new Error("nodes() not implemented");
  }

  entries(lowerBound?: Type.Bound<Uint8Array> | null, upperBound?: Type.Bound<Uint8Array> | null, _options?: { reverse?: boolean; }):
    Type.Sequence<Type.Entry> {
    if (!lowerBound || !upperBound) {
      throw new Error("Bounds must be defined.");
    }
    console.log('!entries', ++ENTRIES);
    return new CTStoreSequence(this.store, lowerBound, upperBound);
  }

  *get(key: Uint8Array): Type.API.Task<Uint8Array | null, Error> {
    console.log('!get');
    let result = yield* Task.wait(this.store.get(padKey(key)));
    return result ?? null;
  }

  *delete(_key: Uint8Array): Type.API.Task<{}, Error> {
    console.log('!delete');
    throw new Error("delete() not implemented");
  }

  *set(key: Uint8Array, value: Uint8Array): Type.API.Task<{}, Error> {
    console.log('!set');
    yield* Task.wait(this.store.set(padKey(key), value));
    return {};
  }

  *integrate(changes: Type.Change[]): Type.API.Task<Type.Node, Error> {
    console.log('!integrate');
    for (const [key, value] of changes) {
      if (value) {
        yield* this.set(key, value)
      } else {
        yield* this.delete(key)
      }
    }

    return yield* this.getRoot()
  }

  *read<T, X extends Error>(read: (reader: Type.StoreReader) => Type.API.Task<T, X>): Type.API.Task<T, X> {
    const result = yield* read(this);
    this.commit();
    console.log('!entries', ++READ);
    return result;
  }

  *write<T, X extends Error>(write: (editor: Type.StoreEditor) => Type.API.Task<T, X>): Type.API.Task<T, X> {
    const result = yield* write(this);
    console.log('!write');
    this.commit();
    return result;
  }

  commit() {
  }

  *clear(): Type.API.Task<{}, Error> {
    // todo!
    throw new Error("clear() not implemented");
    return {};
  }

  *close(): Type.API.Task<{}, Error> {
    // todo!
    this.store.free();
    return {};
  }
}

function padKey(key: Uint8Array): Uint8Array {
  let len = key.length;
  if (len < 96) {
    let buffer = new Uint8Array(96);
    buffer.set(key);
    return buffer;
  } else if (len > 96) {
    throw new Error("key larger than 96");
  } else {
    return key;
  }
}