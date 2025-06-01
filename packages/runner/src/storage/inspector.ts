import type {
  AuthorizationError,
  ConflictError,
  ConsumerCommandInvocation,
  Protocol,
  ProviderCommand,
  Query,
  QueryError,
  Result,
  SchemaQuery,
  Subscribe,
  Transaction,
  TransactionError,
  UCAN,
  Variant,
} from "@commontools/memory/interface";
import type { JSONValue } from "@commontools/builder";

export type Status<Pending extends object, Ready = Pending> =
  | { pending: Pending; ready?: void; time: Time }
  | { pending?: void; ready: Ready; time: Time };

export type Time = number;

export type PushError =
  | ConnectionError
  | ConflictError
  | TransactionError
  | AuthorizationError;

export type PullError =
  | ConnectionError
  | QueryError
  | AuthorizationError;

export type PushState = Record<
  string,
  Result<UCAN<Transaction>, PushError & { time: Time }>
>;

export type PullState = Record<
  string,
  Result<UCAN<Query | SchemaQuery>, PullError & { time: Time }>
>;

export type SubscriptionState = Record<string, {
  source: UCAN<Subscribe>;
  merging?: Transaction;
}>;

export interface ConnectionError extends Error {
  reason: "timeout" | "error" | "close";
  time: Time;
}
export interface Model {
  /**
   * Status of the connection to the upstream. If pending it will contain
   * result holding potentially an error which occurred causing a reconnection
   * if pending and result is ok it is an initial connection.
   */
  connection: Status<Result<Connect, ConnectionError>>;

  /**
   * If pending holds inflight transaction. If ready shows status of the last
   * transaction.
   */
  push: PushState;

  /**
   * If pending shows set of active queries, if ready shows last query result.
   */
  pull: PullState;

  /**
   * Status of current subscriptions.
   */
  subscriptions: Record<string, {
    source: Subscribe | SchemaQuery;
    opened: Time;
    updated?: Time;
    value: JSONValue | undefined;
  }>;
}

export class Model {
  connection: Status<Result<Connect, ConnectionError>>;
  push: PushState;
  pull: PullState;
  subscriptions: Record<string, {
    source: Subscribe | SchemaQuery;
    opened: Time;
    updated?: Time;
    value: JSONValue | undefined;
  }>;
  constructor(
    connection: Status<Result<Connect, ConnectionError>>,
    push: PushState,
    pull: PullState,
    subscriptions: Record<string, {
      source: Subscribe | SchemaQuery;
      opened: Time;
      updated?: Time;
      value: JSONValue | undefined;
    }>,
  ) {
    this.connection = connection;
    this.push = push;
    this.pull = pull;
    this.subscriptions = subscriptions;
  }
}

export type ChannelCallback = (data: BroadcastCommand) => void;

export class Channel extends EventTarget {
  #scope: string;
  #channel: BroadcastChannel;
  #closed: boolean;
  #callback?: ChannelCallback;

  constructor(scope: string, callback?: ChannelCallback) {
    super();
    this.#scope = scope;
    this.#closed = false;
    this.#scope = scope;
    this.#callback = callback;
    this.#channel = new BroadcastChannel("inspector");
    if (this.#callback) {
      this.#channel.addEventListener("message", this.onMessage);
    }
  }

  postMessage(input: Command): BroadcastCommand {
    const command = { ...input, sessionId: this.#scope };
    this.#channel.postMessage(command);
    return command;
  }

  onMessage = (e: MessageEvent<BroadcastCommand>) => {
    if (!this.#callback) {
      return;
    }

    // If sessionId matches scope, or if no scope provided,
    // propagate the message.
    if (!this.#scope || e.data?.sessionId === this.#scope) {
      // Use vanilla callback here rather than extending
      // from EventTarget, as MessageEvents from a BroadcastChannel
      // cannot be re-dispatched.
      this.#callback(e.data);
    }
  };

  close() {
    if (this.#closed) {
      throw new Error("Channel already closed.");
    }
    this.#closed = true;
    this.#channel.close();
    this.#channel.removeEventListener("message", this.onMessage);
  }
}

export const create = (time = Date.now()) =>
  new Model(
    { pending: { ok: { attempt: 0 } }, time },
    {},
    {},
    {},
  );

export type WithSessionId<T> = T & { sessionId?: string };
export type WithTime<T> = T & { time: Time };

export type Disconnect = {
  reason: "timeout" | "error" | "close";
  message: string;
};

export type Connect = {
  attempt: number;
};

export type RawCommand = Variant<{
  send: UCAN<ConsumerCommandInvocation<Protocol>>;
  receive: ProviderCommand<Protocol>;
  integrate: { url: string; value: JSONValue | undefined };
  disconnect: Disconnect;
  connect: Connect;
}>;

export type Command = WithTime<RawCommand>;

export type BroadcastCommand = WithSessionId<Command>;

export const update = (state: Model, command: Command): Model => {
  if (command.send) {
    return send(state, command.time, command.send);
  } else if (command.receive) {
    return receive(state, command.time, command.receive);
  } else if (command.integrate) {
    return integrate(state, command.time, command.integrate);
  } else if (command.disconnect) {
    return disconnect(state, command.time, command.disconnect);
  } else if (command.connect) {
    return connect(state, command.time, command.connect);
  } else {
    console.warn("Unknown command received", command);
    return { ...state };
  }
};

const disconnect = (
  state: Model,
  time: Time,
  { reason, message }: Disconnect,
) => {
  const { connection } = state;
  if (connection.ready) {
    state.connection = {
      pending: { error: Object.assign(new Error(message), { reason, time }) },
      time,
    };
  } else if (connection.pending) {
    state.connection.pending = {
      error: Object.assign(new Error(message), { reason, time }),
    };
    state.connection.time = time;
  }

  return state;
};

const connect = (state: Model, time: Time, { attempt }: Connect) => {
  state.connection = { ready: { ok: { attempt } }, time };
  return state;
};

/**
 * Update state with a status for a new task we pushed to remote.
 */
const send = (
  state: Model,
  time: Time,
  { authorization, invocation }: UCAN<ConsumerCommandInvocation<Protocol>>,
) => {
  const [id] = Object.keys(authorization.access);
  const url = `job:${id}`;
  switch (invocation.cmd) {
    case "/memory/transact": {
      state.push[url] = { ok: { invocation, authorization } };
      return state;
    }
    case "/memory/query": {
      state.pull[url] = { ok: { invocation, authorization } };
      return state;
    }
    case "/memory/graph/query": {
      state.pull[url] = { ok: { invocation, authorization } };
      if (invocation.args.subscribe) {
        state.subscriptions[url] = {
          source: invocation,
          opened: time,
          updated: undefined,
          value: undefined,
        };
      }
      return state;
    }
    case "/memory/query/subscribe": {
      state.subscriptions[url] = {
        source: invocation,
        opened: time,
        updated: undefined,
        value: undefined,
      };
      return state;
    }
    case "/memory/query/unsubscribe": {
      delete state.subscriptions[url];
      return state;
    }
    default: {
      console.warn(`Unknown command invocation`, invocation);
      return state;
    }
  }
};

/**
 * Update pending task because we received it from the remote.
 */
const receive = (
  state: Model,
  time: Time,
  receipt: ProviderCommand<Protocol>,
): Model => {
  switch (receipt.the) {
    case "task/effect":
      return integrate(state, time, {
        url: receipt.of,
        value: receipt.is as unknown as JSONValue,
      });
    case "task/return":
      return complete(state, time, receipt);
    default: {
      console.warn(`Unknown receipts from the remote`, receipt);
      return state;
    }
  }
};

/**
 * Updates state of the pending operation.
 */
const complete = (
  state: Model,
  time: Time,
  { is: result, of }: { is: Result; of: string },
): Model => {
  if (state.pull[of]) {
    if (result.error) {
      state.pull[of] = {
        error: Object.assign(result.error as PullError, { time }),
      };
    } else {
      delete state.pull[of];
    }
  } else if (state.push[of]) {
    if (result.error) {
      state.push[of] = {
        error: Object.assign(result.error as PushError, { time }),
      };
    } else {
      delete state.push[of];
    }
  } else if (state.subscriptions[of]) {
    delete state.subscriptions[of];
  }

  return state;
};

const integrate = (
  state: Model,
  time: Time,
  { url, value }: { url: string; value: JSONValue | undefined },
) => {
  const subscription = state.subscriptions[url];
  if (subscription) {
    subscription.updated = time;
    subscription.value = value;
  } else {
    console.warn(`Received update for unknown subscription ${url}`);
  }

  return state;
};
