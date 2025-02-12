import * as Memory from "./memory.ts";
import type {
  AsyncResult,
  ConnectionError,
  Transaction,
  MemorySession,
  Query,
  Subscriber,
} from "./interface.ts";

export * from "./interface.ts";
export * from "./util.ts";
export * as Error from "./error.ts";
export * as Space from "./space.ts";
export * as Memory from "./memory.ts";
export * as Subscriber from "./subscriber.ts";
export * as Subscription from "./subscription.ts";

export const open = async (options: Memory.Options): AsyncResult<Provider, ConnectionError> => {
  const result = await Memory.open(options);
  if (result.error) {
    return result;
  }

  return { ok: new MemoryProvider(result.ok) };
};

export interface Provider extends MemorySession {
  fetch(request: Request): Promise<Response>;
}

interface Session {
  memory: MemorySession;
}

class MemoryProvider implements Provider {
  constructor(public memory: MemorySession) {}
  subscribe(subscriber: Subscriber) {
    return subscribe(this, subscriber);
  }

  transact(source: Transaction) {
    return transact(this, source);
  }
  query(source: Query) {
    return query(this, source);
  }
  fetch(request: Request) {
    return fetch(this, request);
  }

  close() {
    return this.memory.close();
  }
}

export const transact = ({ memory }: Session, transaction: Transaction) =>
  memory.transact(transaction);

export const query = ({ memory }: Session, source: Query) => memory.query(source);

export const subscribe = ({ memory }: Session, subscriber: Subscriber) =>
  memory.subscribe(subscriber);

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
    const transaction = (await request.json()) as Transaction;
    const result = await session.memory.transact(transaction);
    const body = JSON.stringify(result);
    const status = result.ok ? 200 : result.error.name === "ConflictError" ? 409 : 500;

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
    const selector = (await request.json()) as Query;
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
