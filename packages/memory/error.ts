import type {
  AuthorizationError,
  Conflict,
  ConflictError,
  ConnectionError,
  Fact,
  QueryError,
  SchemaSelector,
  Selector,
  SystemError,
  ToJSON,
  Transaction,
  TransactionError,
} from "./interface.ts";
import { MemorySpace } from "./interface.ts";
import { refer } from "merkle-reference";

export const unauthorized = (
  message: string,
  cause?: Error,
): AuthorizationError => new TheAuthorizationError(message, cause);
export const conflict = (
  transaction: Transaction,
  info: Conflict,
): ToJSON<ConflictError> => new TheConflictError(transaction, info);

export const transaction = (
  transaction: Transaction,
  cause: SystemError,
): ToJSON<TransactionError> => new TheTransactionError(transaction, cause);

export const query = (
  space: MemorySpace,
  selector: Selector | SchemaSelector,
  cause: SystemError,
): ToJSON<QueryError> => new TheQueryError(space, selector, cause);

export const connection = (
  address: URL,
  cause: SystemError,
): ToJSON<ConnectionError> => new TheConnectionError(address.href, cause);

export class TheConflictError extends Error implements ConflictError {
  override name = "ConflictError" as const;
  conflict: Conflict;
  constructor(public transaction: Transaction, conflict: Conflict) {
    const { since, ...actual } = conflict.actual
      ? conflict.actual
      : { actual: null };
    super(
      conflict.expected == null
        ? `The ${conflict.the} of ${conflict.of} in ${conflict.space} already exists as ${
          refer(
            actual,
          )
        }`
        : conflict.actual == null
        ? `The ${conflict.the} of ${conflict.of} in ${conflict.space} was expected to be ${conflict.expected}, but it does not exist`
        : conflict.existsInHistory
        ? `The ${conflict.the} of ${conflict.of} in ${conflict.space} was expected to be ${conflict.expected}, but now it is ${
          refer(actual)
        }`
        : `The ${conflict.the} of ${conflict.of} in ${conflict.space} was expected to be ${conflict.expected}, but it is ${
          refer(actual)
        }`,
    );

    this.conflict = conflict;
  }

  toJSON(): ConflictError {
    return {
      name: this.name,
      stack: this.stack ?? "",
      message: this.message,
      conflict: this.conflict,
      transaction: this.transaction,
    };
  }
}

export type InFact = Fact & { in: string };

export class TheTransactionError extends Error implements TransactionError {
  override name = "TransactionError" as const;
  constructor(
    public transaction: Transaction,
    public override cause: SystemError,
  ) {
    super(`Failed to commit transaction because: ${cause.message}`);
  }
  toJSON(): TransactionError {
    return {
      name: this.name,
      stack: this.stack ?? "",
      message: this.message,
      transaction: this.transaction,
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
    public space: MemorySpace,
    public selector: Selector | SchemaSelector,
    public override cause: SystemError,
  ) {
    super(
      `Query ${JSON.stringify(selector)} in ${space} failed: ${cause.message}`,
    );
  }
  toJSON(): QueryError {
    return {
      name: this.name,
      stack: this.stack ?? "",
      message: this.message,
      space: this.space,
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
  constructor(public address: string, public override cause: SystemError) {
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

export class TheAuthorizationError extends Error implements AuthorizationError {
  override name = "AuthorizationError" as const;
  constructor(message: string, cause?: Error) {
    super(message);
    this.cause = cause;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      stack: this.stack,
      cause: this.cause,
    };
  }
}
