import type {
  ConflictError,
  Conflict,
  Fact,
  TransactionError,
  QueryError,
  ToJSON,
  SystemError,
  ConnectionError,
  Selector,
  ListError,
  Transaction,
} from "./interface.ts";
import { Space } from "./interface.ts";
import { refer } from "./util.ts";

export const conflict = (transaction: Transaction, info: Conflict): ToJSON<ConflictError> =>
  new TheConflictError(transaction, info);

export const transaction = (
  transaction: Transaction,
  cause: SystemError,
): ToJSON<TransactionError> => new TheTransactionError(transaction, cause);

export const query = (selector: Selector & { in: Space }, cause: SystemError): ToJSON<QueryError> =>
  new TheQueryError(selector, cause);

export const list = (
  selector: { in: Space; the?: string; of?: string },
  cause: SystemError,
): ToJSON<ListError> => new TheListError(selector, cause);

export const connection = (address: URL, cause: SystemError): ToJSON<ConnectionError> =>
  new TheConnectionError(address.href, cause);

export class TheConflictError extends Error implements ConflictError {
  override name = "ConflictError" as const;
  conflict: Conflict;
  constructor(public transaction: Transaction, conflict: Conflict) {
    super(
      conflict.expected == null
        ? `The ${conflict.the} of ${conflict.of} in ${conflict.in} already exists as ${refer(
            conflict.actual,
          )}`
        : conflict.actual == null
        ? `The ${conflict.the} of ${conflict.of} in ${conflict.in} was expected to be ${conflict.expected}, but it does not exists`
        : `The ${conflict.the} of ${conflict.of} in ${conflict.in} was expected to be ${
            conflict.expected
          }, but it is ${refer({ is: conflict.actual.is, cause: conflict.actual.cause })}`,
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
  constructor(public transaction: Transaction, public override cause: SystemError) {
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
  constructor(public selector: Selector & { in: Space }, public override cause: SystemError) {
    const { the, of } = selector;
    super(`Query ${JSON.stringify({ the, of })} in ${selector.in} failed: ${cause.message}`);
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

export class TheListError extends Error implements ListError {
  override name = "ListError" as const;
  constructor(
    public selector: { in: Space; the?: string; of?: string },
    public override cause: SystemError,
  ) {
    super(
      `List query ${JSON.stringify({ the: selector.the, of: selector.of })} in ${
        selector.in
      } failed: ${cause.message}`,
    );
  }
  toJSON(): ListError {
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
