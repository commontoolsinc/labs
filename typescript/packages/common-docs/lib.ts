import * as Router from "./router.ts";
export * from "./interface.ts";
export * from "./util.ts";
export * as Error from "./error.ts";
export * as Replica from "./store.ts";
import {
  AsyncResult,
  ConnectionError,
  In,
  Transaction,
  Selector,
  Statement,
  SystemError,
} from "./interface.ts";
import * as Reference from "npm:merkle-reference";

export { Router };

export const open = async (
  options: Router.Options,
): AsyncResult<MemoryService, ConnectionError> => {
  const result = await Router.open(options);
  if (result.error) {
    return result;
  }

  return { ok: new Service(result.ok) };
};

export interface MemoryService {
  close(): AsyncResult<{}, SystemError>;
  subscribe(socket: WebSocket): AsyncResult<{}, Error>;
}

interface MemoryServiceSession {
  router: Router.Router;
}

export type Command = {
  watch?: In<Selector>;
  unwatch?: In<Selector>;
  transact?: In<Transaction>;
};

class Service implements MemoryService {
  constructor(public router: Router.Router) {}
  subscribe(socket: WebSocket) {
    return subscribe(this, socket);
  }
  query(selector: In<Selector>) {
    return this.router.query(selector);
  }
  transact(transaction: In<Transaction>) {
    return this.router.transact(transaction);
  }
  close() {
    return close(this);
  }
}

export const close = ({ router }: MemoryServiceSession) => {
  return Router.close(router);
};

export const subscribe = (session: MemoryServiceSession, socket: WebSocket) => {
  const subscription = session.router.subscribe({});
  socket.onmessage = (event) => {
    const command = parse(event.data) as Command;
    if (command.unwatch) {
      subscription.unwatch(command.unwatch);
    }

    if (command.watch) {
      subscription.watch(command.watch);
    }

    if (command.transact) {
      session.router.transact(command.transact);
    }
  };
  socket.onclose = () => {
    subscription.close();
  };

  return pipeToSocket(subscription.stream, socket);
};

const parse = (source: string) => {
  const command = JSON.parse(source) as Command;
  if (command.transact) {
    command.transact = Object.fromEntries(
      Object.entries(command.transact).map(([key, value]) => [key, decodeTransaction(value)]),
    );
  }

  return command;
};

const decodeTransaction = (transaction: Transaction) =>
  transaction.assert
    ? { assert: decodeStatement(transaction.assert) }
    : { retract: decodeStatement(transaction.retract) };

const decodeStatement = <S extends Statement>(statement: S): S => {
  if (statement.cause && typeof statement.cause["/"] === "string") {
    statement.cause = Reference.fromJSON(statement.cause as unknown as { "/": string });
  }

  if (statement.is && (statement.is as { "/"?: string })["/"]) {
    statement.is = Reference.fromJSON(statement.is as { "/": string });
  }

  return statement;
};

const pipeToSocket = async <T>(
  stream: ReadableStream<T>,
  socket: WebSocket,
): AsyncResult<{}, Error> => {
  try {
    for await (const data of stream) {
      socket.send(JSON.stringify(data));
    }
    socket.close();
    return { ok: {} };
  } catch (error) {
    return { error: error as Error };
  }
};
