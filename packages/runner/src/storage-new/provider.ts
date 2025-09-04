import type {
  IRemoteStorageProviderSettings,
  ISpaceReplica,
  IStorageProviderWithReplica,
  Result,
  SchemaPathSelector,
  State,
  StorageValue,
  Unit,
  URI,
} from "../storage/interface.ts";
import type { BaseMemoryAddress } from "../traverse.ts";
import type { MemorySpace } from "../storage.ts";
import { StorageClient } from "../../../storage/src/client/index.ts";
import { docIdFromUri } from "./address.ts";

/**
 * Placeholder provider to satisfy scaffolding. Will be replaced with the
 * adapter backed by the new storage client.
 */
export class NewStorageProvider implements IStorageProviderWithReplica {
  #client: StorageClient;
  #space: MemorySpace;
  #consumerId: string;
  #delegate: IStorageProviderWithReplica;
  #replica: ISpaceReplica;

  constructor(
    client: StorageClient,
    space: MemorySpace,
    delegate: IStorageProviderWithReplica,
    _settings?: IRemoteStorageProviderSettings,
  ) {
    this.#client = client;
    this.#space = space;
    this.#delegate = delegate;
    this.#consumerId = crypto.randomUUID();
    // Minimal replica backed by the StorageClient composed view
    this.#replica = {
      did: () => this.#space,
      get: (entry: BaseMemoryAddress): State | undefined => {
        try {
          const docId = docIdFromUri(entry.id as any);
          const view = this.#client.readView(String(this.#space), docId).json;
          return view === undefined
            ? undefined
            : { the: entry.type, of: entry.id, is: view as unknown } as State;
        } catch {
          return undefined;
        }
      },
    } as ISpaceReplica;
  }

  // Replica passthrough for scaffolding
  get replica() {
    return this.#replica;
  }

  async send(
    batch: { uri: `${string}:${string}`; value: StorageValue<any> }[],
  ) {
    return await this.#delegate.send(batch);
  }

  async sync(
    uri: URI,
    selector?: SchemaPathSelector,
  ): Promise<Result<Unit, Error>> {
    const docId = docIdFromUri(uri);
    const path = selector?.path ? [...selector.path] : [];
    try {
      await this.#client.get(this.#space, {
        consumerId: this.#consumerId,
        query: { docId, path, schema: selector?.schemaContext },
      });
      return { ok: {} };
    } catch (e) {
      return { error: e as Error };
    }
  }

  async synced() {
    await this.#client.synced(this.#space);
  }

  get<T = any>(uri: string) {
    return this.#delegate.get<T>(uri as any);
  }

  sink<T = any>(uri: string, callback: (value: any) => void) {
    return this.#delegate.sink<T>(uri as any, callback);
  }

  async destroy() {
    await this.#client.disconnect(this.#space);
    await this.#delegate.destroy();
  }

  getReplica() {
    // Return the space DID for compatibility with runner expectations
    return String(this.#space);
  }
}
