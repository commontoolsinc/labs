import * as Memory from "./memory.ts";
import type {
  AsyncResult,
  Await,
  CloseResult,
  ConnectionError,
  ConsumerCommand,
  ConsumerCommandInvocation,
  ConsumerInvocationFor,
  ConsumerResultFor,
  Invocation,
  InvocationURL,
  MemorySession,
  MemorySpace,
  Proto,
  Protocol as Protocol,
  ProviderCommand,
  ProviderCommandFor,
  ProviderSession,
  Query,
  QueryError,
  QueryResult,
  Reference,
  Result,
  Selection,
  Subscribe,
  Subscriber,
  Transaction,
  UCAN,
} from "./interface.ts";
import * as Subscription from "./subscription.ts";
import { backoff } from "./error.ts";
export * from "./interface.ts";
export * from "./util.ts";
export * as Error from "./error.ts";
export * as Space from "./space.ts";
export * as Memory from "./memory.ts";
export * as Subscription from "./subscription.ts";
import { refer } from "./reference.ts";
import * as Access from "./access.ts";
import * as Settings from "./settings.ts";

export interface RateLimitingOptions {
  baseThreshold?: number;
  requestLimit?: number;
  backoffFactor?: number;
  maxDebounceCount?: number;
}

export interface ProviderOptions extends Memory.Options {
  rateLimiting?: RateLimitingOptions;
}

export const open = async (
  options: ProviderOptions,
): AsyncResult<Provider<Protocol>, ConnectionError> => {
  const result = await Memory.open(options);
  if (result.error) {
    return result;
  }

  return { ok: new MemoryProvider(result.ok, options.rateLimiting) };
};

export interface Provider<Protocol extends Proto> {
  fetch(request: Request): Promise<Response>;

  session(): ProviderSession<Protocol>;

  invoke<Ability>(
    ucan: UCAN<ConsumerInvocationFor<Ability, Protocol>>,
  ): Await<ConsumerResultFor<Ability, Protocol>>;

  close(): CloseResult;
}

interface Session {
  memory: MemorySession;
}

class MemoryProvider<
  Space extends MemorySpace,
  MemoryProtocol extends Protocol<Space>,
> implements Provider<MemoryProtocol> {
  sessions: Set<ProviderSession<MemoryProtocol>> = new Set();
  #localSession: MemoryProviderSession<Space, MemoryProtocol> | null = null;
  #rateLimitingOptions: RateLimitingOptions;
  
  constructor(
    public memory: MemorySession, 
    rateLimitingOptions?: RateLimitingOptions
  ) {
    this.#rateLimitingOptions = rateLimitingOptions || {};
  }

  invoke<Ability>(
    ucan: UCAN<ConsumerInvocationFor<Ability, MemoryProtocol>>,
  ): Await<ConsumerResultFor<Ability, MemoryProtocol>> {
    let session = this.#localSession;
    if (!session) {
      session = new MemoryProviderSession(this.memory, null, this.#rateLimitingOptions);
    }

    return session.invoke(
      ucan as unknown as UCAN<ConsumerCommandInvocation<Protocol>>,
    );
  }

  fetch(request: Request) {
    return fetch(this, request);
  }
  session(): ProviderSession<MemoryProtocol> {
    const session = new MemoryProviderSession(this.memory, this.sessions, this.#rateLimitingOptions);
    this.sessions.add(session);
    return session;
  }

  async close() {
    const promises = [];
    for (const session of this.sessions) {
      promises.push(session.close());
    }

    await Promise.all(promises);
    return this.memory.close();
  }
}

class MemoryProviderSession<
  Space extends MemorySpace,
  MemoryProtocol extends Protocol<Space>,
> implements ProviderSession<MemoryProtocol>, Subscriber {
  readable: ReadableStream<ProviderCommand<MemoryProtocol>>;
  writable: WritableStream<UCAN<ConsumerCommandInvocation<MemoryProtocol>>>;
  controller:
    | ReadableStreamDefaultController<ProviderCommand<MemoryProtocol>>
    | undefined;

  channels: Map<InvocationURL<Reference<Subscribe>>, Set<string>> = new Map();

  // Rate limiting properties
  lastRequestTime: number = 0;
  baseThreshold: number;
  requestLimit: number;
  backoffFactor: number;
  maxDebounceCount: number;
  debounceCount: number = 0;

  constructor(
    public memory: MemorySession,
    public sessions: null | Set<ProviderSession<MemoryProtocol>>,
    rateLimitingOptions?: RateLimitingOptions,
  ) {
    // Use provided options or defaults from settings
    this.baseThreshold = rateLimitingOptions?.baseThreshold ?? Settings.rateLimiting.baseThreshold;
    this.requestLimit = rateLimitingOptions?.requestLimit ?? Settings.rateLimiting.requestLimit;
    this.backoffFactor = rateLimitingOptions?.backoffFactor ?? Settings.rateLimiting.backoffFactor;
    this.maxDebounceCount = rateLimitingOptions?.maxDebounceCount ?? Settings.rateLimiting.maxDebounceCount;
    this.readable = new ReadableStream<ProviderCommand<MemoryProtocol>>({
      start: (controller) => this.open(controller),
      cancel: () => this.cancel(),
    });
    this.writable = new WritableStream<
      UCAN<ConsumerCommandInvocation<MemoryProtocol>>
    >({
      write: async (command) => {
        await this.processWithRateLimit(command);
      },
      abort: async () => {
        await this.close();
      },
      close: async () => {
        await this.close();
      },
    });
  }
  perform<Ability extends string>(
    command: ProviderCommandFor<Ability, MemoryProtocol>,
  ) {
    this.controller?.enqueue(command as ProviderCommand<MemoryProtocol>);
    return { ok: {} };
  }
  open(
    controller: ReadableStreamDefaultController<
      ProviderCommand<MemoryProtocol>
    >,
  ) {
    this.controller = controller;
  }
  cancel() {
    const promise = this.writable.close();
    this.dispose();
    return promise;
  }
  close() {
    this.controller?.close();
    this.dispose();

    return { ok: {} };
  }
  dispose() {
    this.controller = undefined;
    this.sessions?.delete(this);
    this.sessions = null;
  }

  /**
   * Process a command with rate limiting.
   * Rejects requests that come too quickly with an error,
   * using same logic as storage.ts for calculating backoff.
   */
  async processWithRateLimit(
    command: UCAN<ConsumerCommandInvocation<MemoryProtocol>>,
  ): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    // Calculate the dynamic threshold based on debounce count
    // First N requests have base threshold, then exponential increase
    const exp = Math.max(0, this.debounceCount - this.requestLimit) ** 2;
    // Randomness here and in storage.ts are unlikely to align 🫣
    const dynamicBackoff = this.backoffFactor * exp * (1 + Math.random());
    const currentThreshold = this.baseThreshold + dynamicBackoff;

    // Check if the request is coming too quickly
    if (timeSinceLastRequest < currentThreshold) {
      // Increase debounce count (capped at configured maximum)
      if (this.debounceCount < this.maxDebounceCount) this.debounceCount++;

      // Recalculate with new debounce count for the error message
      const newExp = Math.max(0, this.debounceCount - this.requestLimit) ** 2;
      const newBackoff = this.backoffFactor * newExp * (1 + Math.random());
      const suggestedWait = Math.round(this.baseThreshold + newBackoff);

      // Return a rate limit error through the command pipeline
      const invocation = command.invocation;
      const of = `job:${refer(invocation)}` as InvocationURL<
        Reference<ConsumerCommandInvocation<Protocol>>
      >;

      this.perform({
        the: "task/return",
        of,
        is: {
          error: backoff(
            `Rate limit exceeded. Please wait at least ${suggestedWait}ms between requests.`,
          ),
        },
      });
      return;
    } else {
      // Reset counter if we're not rate limiting
      this.debounceCount = 0;
    }

    // Update the last request time and process the command
    this.lastRequestTime = now;
    await this.invoke(command as UCAN<ConsumerCommandInvocation<Protocol>>);
  }
  async invoke(
    { invocation, authorization }: UCAN<ConsumerCommandInvocation<Protocol>>,
  ) {
    const { error } = await Access.claim(invocation, authorization);

    if (error) {
      return this.perform({
        the: "task/return",
        of: `job:${refer(invocation)}` as InvocationURL<
          Reference<ConsumerCommandInvocation<MemoryProtocol>>
        >,
        is: { error },
      });
    }

    const of = `job:${refer(invocation)}` as InvocationURL<
      Reference<ConsumerCommandInvocation<Protocol>>
    >;

    switch (invocation.cmd) {
      case "/memory/query": {
        return this.perform({
          the: "task/return",
          of,
          is: (await this.memory.query(invocation)) as Result<
            Selection<Space>,
            QueryError
          >,
        });
      }
      case "/memory/transact": {
        return this.perform({
          the: "task/return",
          of,
          is: await this.memory.transact(invocation),
        });
      }
      case "/memory/query/subscribe": {
        this.channels.set(
          of,
          new Set(
            Subscription.channels(invocation.sub, invocation.args.select),
          ),
        );
        return this.memory.subscribe(this);
      }
      case "/memory/query/unsubscribe": {
        this.channels.delete(of);
        if (this.channels.size === 0) {
          this.memory.unsubscribe(this);
        }

        // End subscription call
        this.perform({
          the: "task/return",
          of: invocation.args.source,
          is: { ok: {} },
        });

        // End unsubscribe call
        return this.perform({
          the: "task/return",
          of,
          is: { ok: {} },
        });
      }
      default: {
        return {
          error: new RangeError(
            `Unknown command ${(invocation as Invocation).cmd}`,
          ),
        };
      }
    }
  }

  transact(transaction: Transaction<Space>) {
    for (const [id, channels] of this.channels) {
      if (Subscription.match(transaction, channels)) {
        // Note that we intentionally exit on the first match because we do not
        // want to send same transaction multiple times to the same consumer.
        // Consumer does it's own bookkeeping of all the subscriptions and will
        // distribute transaction to all of them locally.
        return this.perform({
          the: "task/effect",
          of: id,
          is: transaction,
        });
      }
    }

    return { ok: {} };
  }
}

export const close = ({ memory }: Session) => memory.close();

export const fetch = async (session: Session, request: Request) => {
  if (request.method === "PATCH") {
    return await patch(session, request);
  } else if (request.method === "POST") {
    return await post(session, request);
  } else {
    return new Response(null, { status: 501 });
  }
};

export const patch = async (session: Session, request: Request) => {
  try {
    const transaction = await request.json() as Transaction;
    const result = await session.memory.transact(transaction);
    const body = JSON.stringify(result);
    const status = result.ok
      ? 200
      : result.error.name === "ConflictError"
      ? 409
      : 503;

    return new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (cause) {
    const error = cause as Partial<Error>;
    return new Response(
      JSON.stringify({
        error: {
          name: error?.name ?? "Error",
          message: error?.message ?? "Unable to parse request body",
          stack: error?.stack ?? "",
        },
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
};

export const post = async (session: Session, request: Request) => {
  try {
    const selector = await request.json() as Query;
    const result = await session.memory.query(selector);
    const body = JSON.stringify(result);
    const status = result.ok ? 200 : 404;

    return new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (cause) {
    const error = cause as Partial<Error>;
    return new Response(
      JSON.stringify({
        error: {
          name: error?.name ?? "Error",
          message: error?.message ?? "Unable to parse request body",
          stack: error?.stack ?? "",
        },
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
};
