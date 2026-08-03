import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { type Options, type SessionFactory, StorageManager } from "./v2.ts";

const emulatedMemoryAudience = "did:key:z6Mk-runner-emulated-memory";

class EmulatedSessionFactory implements SessionFactory {
  constructor(private readonly getServer: () => MemoryV2Server.Server) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.getServer()),
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {
          principal: signer?.did(),
        },
      }),
    );
    return { client, session };
  }
}

export class EmulatedStorageManager extends StorageManager {
  #serverFactory: () => MemoryV2Server.Server;
  #server?: MemoryV2Server.Server;

  static emulate(
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): EmulatedStorageManager {
    return new this(
      {
        ...options,
        // Placeholder: the emulated session factory is loopback and never
        // resolves a storage address against this.
        memoryHost: new URL("memory://"),
      },
      () =>
        new MemoryV2Server.Server({
          authorizeSessionOpen(message) {
            const principal = (message.authorization as { principal?: unknown })
              ?.principal;
            return typeof principal === "string" ? principal : undefined;
          },
          sessionOpenAuth: {
            audience: emulatedMemoryAudience,
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

  /**
   * Emulated sessions are loopback — there is no per-space host to
   * resolve, so a host hint can never take effect. Refuse honestly
   * rather than inherit an acceptance that routes nothing.
   */
  override registerSpaceHost(): boolean {
    return false;
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
