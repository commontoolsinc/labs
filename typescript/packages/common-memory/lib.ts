import * as Router from "./router.ts";
export * from "./interface.ts";
export * from "./util.ts";
export * as Error from "./error.ts";
export * as Replica from "./store.ts";
import {
  AsyncResult,
  ConnectionError,
  In,
  Command,
  Transaction,
  Selector,
  Statement,
  SystemError,
} from "./interface.ts";
import * as Reference from "merkle-reference";

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
  patch(request: { json(): Promise<any> }): Promise<Response>;
  patchJson(json: In<Transaction>): Promise<AsyncResult<any, Error>>;
  query(
    request: { json(): Promise<any> },
    selector: In<{ the?: string; of?: string }>,
  ): Promise<Response>;
  queryJson(selector: object): Promise<AsyncResult<any, Error>>;
}

interface MemoryServiceSession {
  router: Router.Router;
}

class Service implements MemoryService {
  constructor(public router: Router.Router) {}
  subscribe(socket: WebSocket) {
    return subscribe(this, socket);
  }
  patch(request: { json(): Promise<any> }): Promise<Response> {
    return patch(this, request);
  }
  patchJson(json: In<Transaction>): Promise<AsyncResult<any, Error>> {
    return patchJson(this.router, json);
  }
  query(request: { json(): Promise<any> }): Promise<Response> {
    return query(this, request);
  }
  queryJson(selector: object): Promise<AsyncResult<any, Error>> {
    return queryJson(this.router, selector as In<Partial<Selector>>);
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
    const command = parseCommand(event.data);
    if (command.unwatch) {
      subscription.unwatch(command.unwatch);
    }

    if (command.watch) {
      subscription.watch(command.watch);
    }
  };
  socket.onclose = () => {
    subscription.close();
  };

  return pipeToSocket(subscription.stream, socket);
};

export const patch = async (session: MemoryServiceSession, request: { json(): Promise<any> }) => {
  try {
    const transaction = asRouterTransaction(await request.json());
    const result = await session.router.transact(transaction);
    const body = JSON.stringify(result);
    const status = result.ok ? 200 : result.error.name === "ConflictError" ? 409 : 500;

    return new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (cause) {
    console.log(cause);
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

export const query = async (session: MemoryServiceSession, request: { json(): Promise<any> }) => {
  try {
    const selector = await request.json();
    const result = await session.router.query(selector);
    const body = JSON.stringify(result);
    const status = result.ok ? 200 : 404;

    return new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (cause) {
    console.log(cause);
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

const parseCommand = (source: string) => JSON.parse(source) as Command;

/**
 * Converts a raw JSON transaction object into a router transaction
 */
const asRouterTransaction = (json: In<Transaction>): In<Transaction> =>
  Object.fromEntries(Object.entries(json).map(([key, value]) => [key, asTransaction(value)]));

const asTransaction = (transaction: Transaction) =>
  transaction.assert
    ? { assert: asStatement(transaction.assert) }
    : { retract: asStatement(transaction.retract) };

const asStatement = <S extends Statement>(statement: S): S => {
  if (statement.cause && typeof statement.cause["/"] === "string") {
    statement.cause = Reference.fromJSON(statement.cause as unknown as { "/": string });
  }
  if (statement.is && (statement.is as { "/"?: string })["/"]) {
    statement.is = Reference.fromJSON(statement.is as { "/": string });
  }
  return statement;
};

/**
 * New library-level patch function that accepts already-parsed JSON
 * and returns a plain result for consumers to build HTTP responses as needed.
 */
export const patchJson = async (
  session: Router.Router,
  json: In<Transaction>,
): Promise<AsyncResult<any, Error>> => {
  try {
    const transaction = asRouterTransaction(json);
    const result = await session.transact(transaction);
    return result;
  } catch (cause) {
    const error = cause as Partial<Error>;
    return {
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? "Unable to process transaction",
        stack: error?.stack ?? "",
      },
    };
  }
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

export const queryJson = async (
  session: Router.Router,
  selector: object,
): Promise<AsyncResult<any, Error>> => {
  try {
    const result = await session.query(selector as In<Partial<Selector>>);
    return result;
  } catch (cause) {
    console.error(cause);
    const error = cause as Partial<Error>;
    return {
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? "Unable to process query",
        stack: error?.stack ?? "",
      },
    };
  }
};
