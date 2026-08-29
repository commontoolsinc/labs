/**
 * The client half of declared holdings (04-protocol.md §4.1.2): on every
 * reconnect the session asks its consumer what the replica holds and puts
 * the answer on the wire — on the resuming `session.open`, and on the
 * `session.watch.set` that re-establishes the watches when the server no
 * longer has the session. The session itself holds no documents; the
 * statement is the consumer's, through `holdingsProvider`.
 */
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { defer } from "@commonfabric/utils/defer";
import { Server } from "../v2/server.ts";
import { connect, type Transport } from "../v2/client.ts";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type SessionHolding,
} from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-client-holdings";

type Sent = { type?: string; holdings?: SessionHolding[] };

/**
 * A loopback transport over a real server whose connection can be
 * dropped, recording every request the client sends so the reconnect's
 * requests can be inspected. `retarget` points later connections at a
 * different server — the shape of a server that forgot the session.
 * `stripSessionHoldings` erases that flag from the server's `hello.ok` —
 * the shape of a server that cannot take a declaration.
 */
class DroppableTransport implements Transport {
  readonly sent: Sent[] = [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;

  #server: Server;
  readonly #stripSessionHoldings: boolean;

  constructor(server: Server, stripSessionHoldings = false) {
    this.#server = server;
    this.#stripSessionHoldings = stripSessionHoldings;
  }

  async send(payload: string): Promise<void> {
    this.sent.push(decodeMemoryBoundary(payload) as Sent);
    await this.#openConnection().receive(payload);
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    queueMicrotask(() => this.#closeReceiver(new Error("disconnect")));
  }

  retarget(server: Server): void {
    this.#server = server;
  }

  #openConnection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.#connection = this.#server.connect((message) => {
        this.#receiver(encodeMemoryBoundary(this.#project(message)));
      });
    }
    return this.#connection;
  }

  #project<T>(message: T): T {
    if (this.#stripSessionHoldings) {
      const framed = message as { type?: string; flags?: object };
      if (framed.type === "hello.ok" && framed.flags !== undefined) {
        return {
          ...framed,
          flags: { ...framed.flags, sessionHoldings: false },
        } as T;
      }
    }
    return message;
  }
}

const newServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}-${crypto.randomUUID()}`),
  });

/** Resolves once the transport has sent a request of `type` carrying
 * holdings, with those holdings. */
const holdingsSentOn = (
  transport: DroppableTransport,
  type: string,
): Promise<SessionHolding[]> => {
  const seen = defer<SessionHolding[]>();
  const original = transport.send.bind(transport);
  transport.send = async (payload: string) => {
    await original(payload);
    const last = transport.sent.at(-1);
    if (last?.type === type && last.holdings !== undefined) {
      seen.resolve(last.holdings);
    }
  };
  return seen.promise;
};

const DECLARED: SessionHolding[] = [{ id: "of:client-held", seq: 3 }];

describe("client holdings", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("declares the provider's holdings on the reopen that resumes a session", async () => {
    const server = newServer("client-holdings-resume");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    session.holdingsProvider = () => DECLARED;
    await session.watchSet([{
      id: "w",
      kind: "graph",
      query: {
        roots: [{
          id: "of:client-held",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    const reopened = holdingsSentOn(transport, "session.open");
    transport.disconnect();
    expect(await reopened).toEqual(DECLARED);
  });

  it("declares the provider's holdings on the watch.set that re-establishes a forgotten session", async () => {
    const server = newServer("client-holdings-forgotten");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    session.holdingsProvider = () => DECLARED;
    await session.watchSet([{
      id: "w",
      kind: "graph",
      query: {
        roots: [{
          id: "of:client-held",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    // A server that never saw the session: the open is not resumed, so
    // the client re-establishes its watches — declaring what it holds.
    const forgetful = newServer("client-holdings-forgetful");
    cleanups.push(() => forgetful.close());
    transport.retarget(forgetful);
    const reestablished = holdingsSentOn(transport, "session.watch.set");
    transport.disconnect();
    expect(await reestablished).toEqual(DECLARED);
  });

  it("terminates the session at restore when the server cannot take its declared holdings", async () => {
    const server = newServer("client-holdings-unsupported");
    const transport = new DroppableTransport(server, true);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    // The initial connection is allowed: nothing is held yet, so nothing
    // needs declaring, and the mount and its watches work in full.
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    session.holdingsProvider = () => DECLARED;
    await session.watchSet([{
      id: "w",
      kind: "graph",
      query: {
        roots: [{
          id: "of:client-held",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    // Restoration is not: a declaration-bearing session cannot fall back
    // to the delivery paths the declaration exists to replace, so the
    // restore terminates the session with the cause.
    await session.restore();
    expect(session.closeError?.message).toContain("sessionHoldings");
    await expect(session.watchSet([])).rejects.toThrow("sessionHoldings");
  });

  it("restores a session without a provider against a server that cannot take holdings", async () => {
    const server = newServer("client-holdings-unsupported-no-provider");
    const transport = new DroppableTransport(server, true);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    // No provider means no declaration to lose: the declaration-less
    // delivery paths are this consumer's contract, on any server.
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    await session.restore();
    expect(session.closeError).toBeUndefined();
  });

  it("declares nothing when no provider is installed", async () => {
    const server = newServer("client-holdings-none");
    const transport = new DroppableTransport(server);
    const client = await connect({ transport });
    cleanups.push(() => client.close(), () => server.close());
    await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    // The mount's own open is already sent; the next one is the reconnect's.
    const reopened = defer<Sent>();
    const original = transport.send.bind(transport);
    transport.send = async (payload: string) => {
      await original(payload);
      const last = transport.sent.at(-1);
      if (last?.type === "session.open") reopened.resolve(last);
    };
    transport.disconnect();
    const reopen = await reopened.promise;
    assert(reopen !== undefined, "the reconnect reopened the session");
    expect("holdings" in reopen).toBe(false);
  });
});
