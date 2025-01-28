import type {
  ConflictError,
  Conflict,
  Fact,
  TransactionError,
  QueryError,
  ToJSON,
  SystemError,
  ConnectionError,
  In,
  Selector,
} from "./interface.ts";
import { refer } from "./util.ts";

export const conflict = (info: Conflict): ToJSON<ConflictError> =>
  new TheConflictError(info);

export const transaction = (
  fact: InFact,
  cause: SystemError,
): ToJSON<TransactionError> => new TheTransactionError(fact, cause);

export const query = (
  selector: In<Selector>,
  cause: SystemError,
): ToJSON<QueryError> => new TheQueryError(selector, cause);

export const connection = (
  address: URL,
  cause: SystemError,
): ToJSON<ConnectionError> => new TheConnectionError(address.href, cause);

export class TheConflictError extends Error implements ConflictError {
  override name = "ConflictError" as const;
  conflict: Conflict;
  constructor(conflict: Conflict) {
    super(
      conflict.expected == null
        ? `The ${conflict.the} of ${conflict.of} in ${conflict.in} already exists as ${refer(conflict.actual)}`
        : conflict.actual == null
          ? `The ${conflict.the} of ${conflict.of} in ${conflict.in} was expected to be ${conflict.expected}, but it does not exists`
          : `The ${conflict.the} of ${conflict.of} in ${conflict.in} was expected to be ${conflict.expected}, but it is ${refer(conflict.actual)}`,
    );

    this.conflict = conflict;
  }

  toJSON(): ConflictError {
    return {
      name: this.name,
      stack: this.stack ?? "",
      message: this.message,
      conflict: this.conflict,
    };
  }
}

export type InFact = In<Fact>;

export class TheTransactionError extends Error implements TransactionError {
  override name = "StoreError" as const;
  constructor(
    public fact: InFact,
    public override cause: SystemError,
  ) {
    super(
      `Failed to update ${fact.the} of ${fact.of} in ${fact.in}: ${cause.message}`,
    );
  }
  toJSON(): TransactionError {
    return {
      name: this.name,
      stack: this.stack ?? "",
      message: this.message,
      fact: this.fact,
      cause: {
        name: this.cause.name,
        code: this.cause.code,
        message: this.cause.message,
        stack: this.cause.stack ?? "",
      },
    };
  }
}

export class TheQueryError extends Error implements QueryError {
  override name = "QueryError" as const;
  constructor(
    public selector: In<Selector>,
    public override cause: SystemError,
  ) {
    const { the, of } = selector;
    super(
      `Query ${JSON.stringify({ the, of })} in ${selector.in} failed: ${cause.message}`,
    );
  }
  toJSON(): QueryError {
    return {
      name: this.name,
      stack: this.stack ?? "",
      message: this.message,
      selector: this.selector,
      cause: {
        name: this.cause.name,
        code: this.cause.code,
        message: this.cause.message,
        stack: this.cause.stack ?? "",
      },
    };
  }
}

export class TheConnectionError extends Error implements ConnectionError {
  override name = "ConnectionError" as const;
  constructor(
    public address: string,
    public override cause: SystemError,
  ) {
    super(`Failed to connect to ${address}: ${cause.message}`);
  }
  toJSON(): ConnectionError {
    return {
      name: this.name,
      stack: this.stack ?? "",
      message: this.message,
      address: this.address,
      cause: {
        name: this.cause.name,
        code: this.cause.code,
        message: this.cause.message,
        stack: this.cause.stack ?? "",
      },
    };
  }
}
