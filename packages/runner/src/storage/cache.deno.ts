import * as MemoryProvider from "@commontools/memory/provider";
import * as Consumer from "@commontools/memory/consumer";
import * as V2Storage from "./v2.ts";
import * as V2Emulate from "./v2-emulate.ts";
import {
  DEFAULT_MEMORY_VERSION,
  type Options,
  Provider,
  StorageManager as BaseStorageManager,
  type V1StorageManagerOptions,
  type V2StorageManagerOptions,
} from "./cache.ts";
import * as StorageSubscription from "./subscription.ts";
import type { MemorySpace } from "@commontools/memory/interface";
import type { IStorageSubscription } from "./interface.ts";
export * from "./cache.ts";

export class StorageManagerEmulator extends BaseStorageManager {
  #session?: Consumer.MemoryConsumer<MemorySpace>;
  #subscription = StorageSubscription.create();
  #memoryProvider?: ReturnType<typeof MemoryProvider.emulate>;

  #providers: Map<string, Provider> = new Map();

  session() {
    if (!this.#session) {
      this.#memoryProvider = MemoryProvider.emulate({
        serviceDid: this.as.did(),
        memoryVersion: this.memoryVersion,
      });
      this.#session = Consumer.open({
        as: this.as,
        session: this.#memoryProvider.session(),
      });
    }
    return this.#session;
  }
  override connect(space: MemorySpace) {
    return Provider.open({
      space,
      session: this.session(),
      subscription: this.#subscription,
      memoryVersion: this.memoryVersion,
    });
  }

  override open(space: MemorySpace): Provider {
    return super.open(space) as Provider;
  }

  mount(space: MemorySpace) {
    return this.session().mount(space);
  }

  /**
   * Subscribes to changes in the storage.
   */
  override subscribe(subscription: IStorageSubscription): void {
    this.#subscription.subscribe(subscription);
  }

  override async close() {
    await super.close();
    // Dispose provider sessions to clear pending schema flush timers,
    // without closing the ReadableStream pipe (which would prevent
    // runtime.dispose() → scheduler.idle() from settling).
    this.#memoryProvider?.disposeSessions();
    if (this.#session) {
      this.#session.close();
      await this.#session.closed;
    }
  }
}

export class StorageManager extends BaseStorageManager {
  static override open(
    options: V1StorageManagerOptions,
  ): StorageManager | StorageManagerEmulator;
  static override open(
    options: V2StorageManagerOptions,
  ): V2Storage.StorageManager | V2Emulate.EmulatedStorageManager;
  static override open(
    options: Options,
  ): StorageManager | StorageManagerEmulator | V2Storage.StorageManager |
    V2Emulate.EmulatedStorageManager;
  static override open(
    options: Options,
  ): StorageManager | StorageManagerEmulator | V2Storage.StorageManager |
    V2Emulate.EmulatedStorageManager {
    const memoryVersion = options.memoryVersion ?? DEFAULT_MEMORY_VERSION;
    if (memoryVersion === "v2") {
      if (options.address.protocol === "memory:") {
        return this.emulate(options);
      }
      return V2Storage.StorageManager.open(options);
    }
    if (options.address.protocol === "memory:") {
      return this.emulate(options);
    } else {
      return new this(options);
    }
  }
  static emulate(
    options: Omit<V1StorageManagerOptions, "address">,
  ): StorageManagerEmulator;
  static emulate(
    options: Omit<V2StorageManagerOptions, "address">,
  ): V2Emulate.EmulatedStorageManager;
  static emulate(
    options: Omit<Options, "address">,
  ): StorageManagerEmulator | V2Emulate.EmulatedStorageManager;
  static emulate(
    options: Omit<Options, "address">,
  ): StorageManagerEmulator | V2Emulate.EmulatedStorageManager {
    const memoryVersion = options.memoryVersion ?? DEFAULT_MEMORY_VERSION;
    if (memoryVersion === "v2") {
      return V2Emulate.EmulatedStorageManager.emulate(options);
    }
    return new StorageManagerEmulator({
      ...options,
      address: new URL("memory://"),
    });
  }
}
