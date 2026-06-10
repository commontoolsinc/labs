import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { type Options, type SessionFactory, StorageManager } from "./v2.ts";

class EmulatedSessionFactory implements SessionFactory {
  constructor(private readonly getServer: () => MemoryV2Server.Server) {}

  async create(space: MemorySpace, signer?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.getServer()),
    });
    const session = await client.mount(space, {}, () => ({
      invocation: {},
      authorization: {
        principal: signer?.did(),
      },
    }));
    return { client, session };
  }
}

export class EmulatedStorageManager extends StorageManager {
  #serverFactory: () => MemoryV2Server.Server;
  #server?: MemoryV2Server.Server;

  static emulate(
    options: Omit<Options, "apiUrl">,
  ): EmulatedStorageManager {
    return new this(
      {
        ...options,
        apiUrl: new URL("memory://"),
      },
      () =>
        new MemoryV2Server.Server({
          authorizeSessionOpen(message) {
            const principal = (message.authorization as { principal?: unknown })
              ?.principal;
            return typeof principal === "string" ? principal : undefined;
          },
        }),
    );
  }

  protected constructor(
    options: Options,
    serverFactory: () => MemoryV2Server.Server,
  ) {
    const serverHolder: { get: () => MemoryV2Server.Server } = {
      get: () => {
        throw new Error("Emulated server requested before initialization");
      },
    };
    super(options, new EmulatedSessionFactory(() => serverHolder.get()));
    this.#serverFactory = serverFactory;
    serverHolder.get = () => this.server();
  }

  override async close(): Promise<void> {
    await super.close();
    if (this.#server) {
      await this.#server.close();
    }
  }

  protected server(): MemoryV2Server.Server {
    this.#server ??= this.#serverFactory();
    return this.#server;
  }
}
