import type {
  IRemoteStorageProviderSettings,
  IStorageProviderWithReplica,
  Result,
  SchemaPathSelector,
  StorageValue,
  Unit,
  URI,
} from "../storage/interface.ts";
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
  }

  // Replica passthrough for scaffolding
  get replica() {
    return this.#delegate.replica;
  }

  async send(
    batch: { uri: `${string}:${string}`; value: StorageValue<any> }[],
  ) {
    return await this.#delegate.send(batch);
  }

  async sync(uri: URI, selector?: SchemaPathSelector): Promise<Result<Unit, Error>> {
    const docId = docIdFromUri(uri);
    const path = selector?.path ? [...selector.path] : [];
    try {
      await this.#client.get(this.#space, {
        consumerId: this.#consumerId,
        query: { docId, path },
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
    return this.#delegate.getReplica();
  }
}
