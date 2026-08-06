import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { type Options, type SessionFactory, StorageManager } from "./v2.ts";

const emulatedMemoryAudience = "did:key:z6Mk-runner-emulated-memory";

// Nudge the server's session fan-out after each request, on a microtask. A
// commit promise resolves at marker coverage (CT-1950), and the catch-up
// marker rides the batched fan-out; behind the server's coalescing TIMER it
// is unreachable for a caller whose whole await chain is microtask-driven —
// the loopback transport resolves every request on microtasks, so an await
// cascade never yields the timer turn the flush needs, and every awaited
// commit deadlocks. Flushing after each send puts marker delivery in the
// same scheduling class as the request round-trip itself: if you await the
// round trip, the fan-out it staged arrives too. The server stays stock —
// its timer still runs and finds nothing left to flush.
const flushOnSendTransport = (
  transport: MemoryV2Client.Transport,
  getServer: () => MemoryV2Server.Server,
): MemoryV2Client.Transport => ({
  ...transport,
  async send(payload: string) {
    await transport.send(payload);
    queueMicrotask(() => {
      void getServer().flushSessions().catch(() => {});
    });
  },
});

class EmulatedSessionFactory implements SessionFactory {
  constructor(
    private readonly getServer: () => MemoryV2Server.Server,
    private readonly flushOnSend: boolean,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryV2Client.MountOptions = {},
  ) {
    const transport = MemoryV2Client.loopback(this.getServer());
    const client = await MemoryV2Client.connect({
      transport: this.flushOnSend
        ? flushOnSendTransport(transport, this.getServer)
        : transport,
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
      // Single-manager emulation wants request-coupled fan-out (see
      // flushOnSendTransport). Harnesses that share one server across
      // managers use the protected constructor and keep the server's timed
      // cadence: their controlled-staleness premises depend on frames NOT
      // spreading until the test lets them.
      true,
    );
  }

  protected constructor(
    options: Options,
    serverFactory: () => MemoryV2Server.Server,
    flushOnSend = false,
  ) {
    const serverHolder: { get: () => MemoryV2Server.Server } = {
      get: () => {
        throw new Error("Emulated server requested before initialization");
      },
    };
    super(
      options,
      new EmulatedSessionFactory(() => serverHolder.get(), flushOnSend),
    );
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
