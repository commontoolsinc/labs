import * as MemoryProvider from "@commontools/memory/provider";
import * as Consumer from "@commontools/memory/consumer";
import {
  type Options,
  Provider,
  StorageManager as BaseStorageManager,
} from "./cache.ts";
import type { MemorySpace } from "@commontools/memory/interface";
export * from "./cache.ts";

export class StorageManagerEmulator extends BaseStorageManager {
  #session?: Consumer.MemoryConsumer<MemorySpace>;

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
    return Provider.open({
      space,
      session: this.session(),
    });
  }

  mount(space: MemorySpace) {
    return this.session().mount(space);
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
