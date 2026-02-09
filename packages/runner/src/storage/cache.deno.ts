import * as MemoryProvider from "@commontools/memory/provider";
import * as Consumer from "@commontools/memory/consumer";
import {
  type Options,
  Provider,
  StorageManager as BaseStorageManager,
} from "./cache.ts";
import * as StorageSubscription from "./subscription.ts";
import type { MemorySpace } from "@commontools/memory/interface";
import type { IStorageSubscription } from "./interface.ts";
import { ProviderV2 } from "./v2/provider.ts";
// Deno-only imports — safe here since cache.deno.ts is never bundled for browser
import { SpaceV2 } from "@commontools/memory/v2/space";
import { ProviderSession } from "@commontools/memory/v2/provider";
import { connectLocal } from "@commontools/memory/v2/consumer";
export * from "./cache.ts";

export class StorageManagerEmulator extends BaseStorageManager {
  #session?: Consumer.MemoryConsumer<MemorySpace>;
  #subscription = StorageSubscription.create();

  #providers: Map<string, Provider> = new Map();

  session() {
    if (!this.#session) {
      const provider = MemoryProvider.emulate({ serviceDid: this.as.did() });
      this.#session = Consumer.open({
        as: this.as,
        session: provider.session(),
      });
    }
    return this.#session;
  }
  override connect(space: MemorySpace) {
    // v2 flag: create a v2 provider instead of v1
    if (this.memoryVersion === "v2") {
      const v2Space = SpaceV2.open({ url: new URL("memory:v2") });
      const providerSession = new ProviderSession(v2Space);
      const consumer = connectLocal(providerSession);
      return ProviderV2.open({
        spaceId: space,
        consumer,
        subscription: this.#subscription,
        space: v2Space,
        providerSession,
      });
    }
    return Provider.open({
      space,
      session: this.session(),
      subscription: this.#subscription,
    });
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
}

export class StorageManager extends BaseStorageManager {
  static override open(options: Options) {
    if (options.address.protocol === "memory:") {
      return this.emulate(options);
    } else {
      return new this(options);
    }
  }
  static emulate(
    options: Omit<Options, "address">,
  ) {
    return new StorageManagerEmulator({
      ...options,
      address: new URL("memory://"),
    });
  }
}
