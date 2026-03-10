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
export * from "./cache.ts";

const assertV1StorageActive = (
  memoryVersion: "v1" | "v2",
  context: string,
): void => {
  if (memoryVersion === "v2") {
    throw new Error(
      `v1 storage code path reached with memoryVersion="v2": ${context}. ` +
        "V2 storage wiring is not implemented yet.",
    );
  }
};

export class StorageManagerEmulator extends BaseStorageManager {
  #session?: Consumer.MemoryConsumer<MemorySpace>;
  #subscription = StorageSubscription.create();
  #memoryProvider?: ReturnType<typeof MemoryProvider.emulate>;

  #providers: Map<string, Provider> = new Map();

  session() {
    assertV1StorageActive(this.memoryVersion, "StorageManagerEmulator.session");
    if (!this.#session) {
      this.#memoryProvider = MemoryProvider.emulate({
        serviceDid: this.as.did(),
      });
      this.#session = Consumer.open({
        as: this.as,
        session: this.#memoryProvider.session(),
      });
    }
    return this.#session;
  }
  override connect(space: MemorySpace) {
    assertV1StorageActive(this.memoryVersion, "StorageManagerEmulator.connect");
    return Provider.open({
      space,
      session: this.session(),
      subscription: this.#subscription,
    });
  }

  mount(space: MemorySpace) {
    assertV1StorageActive(this.memoryVersion, "StorageManagerEmulator.mount");
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
