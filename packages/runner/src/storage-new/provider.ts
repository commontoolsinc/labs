import type {
  IStorageProviderWithReplica,
  StorageValue,
} from "../storage/interface.ts";

/**
 * Placeholder provider to satisfy scaffolding. Will be replaced with the
 * adapter backed by the new storage client.
 */
export class NewStorageProvider implements IStorageProviderWithReplica {
  constructor(private readonly delegate: IStorageProviderWithReplica) {}

  // Replica passthrough for scaffolding
  get replica() {
    return this.delegate.replica;
  }

  async send(batch: { uri: `${string}:${string}`; value: StorageValue<any> }[]) {
    return await this.delegate.send(batch);
  }

  async sync(uri: string, selector?: any) {
    return await this.delegate.sync(uri as any, selector);
  }

  async synced() {
    await this.delegate.synced();
  }

  get<T = any>(uri: string) {
    return this.delegate.get<T>(uri as any);
  }

  sink<T = any>(uri: string, callback: (value: any) => void) {
    return this.delegate.sink<T>(uri as any, callback);
  }

  async destroy() {
    await this.delegate.destroy();
  }

  getReplica() {
    return this.delegate.getReplica();
  }
}


