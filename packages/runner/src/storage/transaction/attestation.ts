import { isRecord } from "@commontools/utils/types";
import type {
  IAttestation,
  IInvalidDataURIError,
  IMemoryAddress,
  INotFoundError,
  ISpaceReplica,
  IStorageTransactionInconsistent,
  ITypeMismatchError,
  IUnsupportedMediaTypeError,
  JSONValue,
  MemoryAddressPathComponent,
  MemorySpace,
  Result,
  State,
} from "../interface.ts";
import { unclaimed } from "@commontools/memory/fact";

export class InvalidDataURIError extends Error implements IInvalidDataURIError {
  override readonly name = "InvalidDataURIError";
  declare readonly cause: Error;

  constructor(
    message: string,
    cause?: Error,
  ) {
    super(message);
    if (cause) {
      this.cause = cause;
    }
  }

  from(space: MemorySpace) {
    return this;
  }
}

export class UnsupportedMediaTypeError extends Error
  implements IUnsupportedMediaTypeError {
  override readonly name = "UnsupportedMediaTypeError";

  constructor(message: string) {
    super(message);
  }

  from(space: MemorySpace) {
    return this;
  }
}

/**
 * Takes `source` attestation, `address` and `value` and produces derived
 * attestation with `value` set to a property that given `address` leads to
 * in the `source`. Fails with type mismatch error if provided `address` leads
 * to a non-object target, or NotFound error if the document doesn't exist.
 */
export const write = (
  source: IAttestation,
  address: IMemoryAddress,
  value: JSONValue | undefined,
): Result<
  IAttestation,
  IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
> => {
  if (address.path.length === source.address.path.length) {
    return { ok: { ...source, value } };
  } else {
    const path = [...address.path];
    const key = path.pop()!;
    const patch = {
      ...source,
      value: source.value === undefined
        ? source.value
        : JSON.parse(JSON.stringify(source.value)),
    };

    const { ok, error } = resolve(patch, { ...address, path });

    if (error) {
      return { error };
    } else {
      const type = ok.value === null
        ? "null"
        : Array.isArray(ok.value)
        ? "array"
        : typeof ok.value;
      if (
        type === "object" ||
        (type === "array" &&
          ((Number.isInteger(Number(key)) && Number(key) >= 0) ||
            key === "length"))
      ) {
        const target = ok.value as Record<string, JSONValue>;

        // If target value is same as desired value this write is a noop
        if (target[key] === value) {
          return { ok: source };
        } else if (value === undefined) {
          // If value is `undefined` we delete property from the tagret
          delete target[key];
        } else {
          // Otherwise we assign value to the target
          target[key] = value;
        }

        return { ok: patch };
      } else {
        // Type mismatch - trying to write property on non-object
        return {
          error: new TypeMismatchError(
            address,
            type,
            "write",
          ),
        };
      }
    }
  }
};

/**
 * Reads requested `address` from the provided `source` attestation and either
 * succeeds with derived {@link IAttestation} with the given `address` or fails
 * with inconsistency error if resolving an `address` encounters a non-object
 * along the path. Note it will succeed with `undefined` if last component of
 * the path does not exist on the object. Below are some examples illustrating
 * read behavior
 *
 * ```ts
 * const address = {
 *   id: "test:1",
 *   type: "application/json",
 *   path: []
 * }
 * const value = { hello: "world", from: { user: { name: "Alice" } } }
 * const source = { address, value }
 *
 * read({ ...address, path: [] }, source)
 * // { ok: { address, value } }
 * read({ ...address, path: ['hello'] }, source)
 * // { ok: { address: { ...address, path: ['hello'] }, value: "hello" } }
 * read({ ...address, path: ['hello', 'length'] }, source)
 * // { ok: { address: { ...address, path: ['hello'] }, value: undefined } }
 * read({ ...address, path: ['hello', 0] }, source)
 * // { ok: { address: { ...address, path: ['hello', 0] }, value: undefined } }
 * read({ ...address, path: ['hello', 0, 0] }, source)
 * // { error }
 * read({ ...address, path: ['from', 'user'] }, source)
 * // { ok: { address: { ...address, path: ['from', 'user'] }, value: {name: "Alice"} } }
 *
 * const empty = { address, value: undefined }
 * read(address, empty)
 * // { ok: { address, value: undefined } }
 * read({ ...address, path: ['a'] }, empty)
 * // { error }
 * ```
 */
export const read = (
  source: IAttestation,
  address: IMemoryAddress,
): Result<
  IAttestation,
  IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
> => resolve(source, address);

/**
 * Takes a source fact {@link State} and derives an attestion describing its
 * state.
 */
export const attest = ({ the, of, is }: Omit<State, "cause">): IAttestation => {
  return {
    address: { id: of, type: the, path: [] },
    value: is,
  };
};

/**
 * Verifies consistency of provided attestation with a given replica. If
 * current state matches provided attestation function succeeds with a state
 * of the fact in the given replica otherwise function fails with
 * `IStorageTransactionInconsistent` error.
 */
export const claim = (
  { address, value: expected }: IAttestation,
  replica: ISpaceReplica,
): Result<State, IStorageTransactionInconsistent> => {
  const [the, of] = [address.type, address.id];
  const state = replica.get({ the, of }) ?? unclaimed({ the, of });
  const source = attest(state);
  const actual = read(source, address)?.ok?.value;

  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return { ok: state };
  } else {
    return {
      error: new StateInconsistency({ address, expected, actual }),
    };
  }
};

/**
 * Attempts to resolve given `address` from the `source` attestation. Function
 * succeeds with derived attestation that will have provided `address` or fails
 * with a not found error if the path doesn't exist, or a type mismatch error if
 * resolving an address encounters non-object along the resolution path.
 */
export const resolve = (
  source: IAttestation,
  address: IMemoryAddress,
): Result<
  IAttestation,
  IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
> => {
  const { path } = address;
  let at = source.address.path.length - 1;
  let value = source.value;

  // If the source value is undefined (document doesn't exist), return NotFound
  if (source.value === undefined && path.length > source.address.path.length) {
    return {
      error: new NotFound(
        source,
        address,
        // Last valid path component is assumed to be the one that points to
        // `undefined`. If the path was empty this means the document doesn't
        // exist at all. If it isn't empty, we're assuming the parent is
        // correct, but that depends on the validity of the source attestation.
        source.address.path.length > 0
          ? source.address.path.slice(0, -1)
          : undefined,
      ),
    };
  }

  while (++at < path.length) {
    const key = path[at];
    if (isRecord(value)) {
      value = value[key] as JSONValue;
    } else {
      // If the value is undefined, the path doesn't exist, but we can still
      // write onto it. Return error with last valid path component.
      if (value === undefined) {
        return {
          error: new NotFound(source, address, path.slice(0, at)),
        };
      }
      // Type mismatch - trying to access property on non-object
      const actualType = value === null ? "null" : typeof value;
      return {
        error: new TypeMismatchError(
          { ...address, path: path.slice(0, at + 1) },
          actualType,
          "read",
        ),
      };
    }
  }

  return { ok: { value, address } };
};

/**
 * Loads an attestation from a data URI address. Parses the data URI content
 * and returns an attestation with the parsed value.
 */
export const load = (
  address: Omit<IMemoryAddress, "path">,
): Result<IAttestation, IInvalidDataURIError | IUnsupportedMediaTypeError> => {
  try {
    // Parse data URI using URL constructor
    const url = new URL(address.id);

    if (url.protocol !== "data:") {
      return {
        error: new InvalidDataURIError(
          "Invalid data URI: protocol must be 'data:'",
        ),
      };
    }

    const [mediaTypeAndParams, data] = url.pathname.split(",");

    if (data === undefined) {
      return {
        error: new InvalidDataURIError(
          "Invalid data URI format: missing comma separator",
          undefined,
        ),
      };
    }

    // Parse media type and parameters
    const params = mediaTypeAndParams.split(";");
    const mediaType = params[0] || "text/plain";
    const isBase64 = params.includes("base64");

    // Decode data
    const content = isBase64 ? atob(data) : decodeURIComponent(data);

    // Check if media type matches address.type
    if (mediaType !== address.type) {
      // Media type mismatch - return error
      return {
        error: new UnsupportedMediaTypeError(
          `Media type mismatch: expected "${address.type}" but data URI contains "${mediaType}"`,
        ),
      };
    }

    // Handle JSON media type
    if (mediaType === "application/json") {
      let value: JSONValue;
      try {
        value = JSON.parse(content);
      } catch (error) {
        const reason = error as Error;
        return {
          error: new InvalidDataURIError(
            `Failed to parse JSON from data URI: ${reason.message}`,
            reason,
          ),
        };
      }

      return { ok: { address: { ...address, path: [] }, value } };
    }

    if (mediaType.startsWith("text/")) {
      // Handle other media types - store as string for now since we do not
      // support blobs yet.
      return { ok: { address: { ...address, path: [] }, value: content } };
    }

    return {
      error: new UnsupportedMediaTypeError(
        `Unsupported media type ${mediaType}`,
      ),
    };
  } catch (error) {
    const reason = error as Error;
    return {
      error: new InvalidDataURIError(
        `Invalid data URI: ${reason.message}`,
        reason,
      ),
    };
  }
};

export class NotFound extends RangeError implements INotFoundError {
  override name = "NotFoundError" as const;
  declare readonly source: IAttestation;
  declare readonly address: IMemoryAddress;
  declare readonly path: readonly MemoryAddressPathComponent[] | undefined;

  constructor(
    source: IAttestation,
    address: IMemoryAddress,
    path?: readonly MemoryAddressPathComponent[],
  ) {
    let message: string;

    // Document doesn't exist
    if (source.value === undefined && source.address.path.length === 0) {
      message = `Document not found: ${address.id}`;
    } // Path doesn't exist within document
    else {
      message = `Cannot access path [${address.path.join(", ")}] - ${
        source.value === undefined
          ? "document does not exist"
          : "path does not exist"
      }`;
    }

    super(message);
    this.source = source;
    this.address = address;
    this.path = path;
  }

  from(space: MemorySpace) {
    // Return the same error instance as it doesn't use space in the message
    return this;
  }
}

export class TypeMismatchError extends TypeError implements ITypeMismatchError {
  override name = "TypeMismatchError" as const;
  declare readonly address: IMemoryAddress;
  declare readonly actualType: string;

  constructor(
    address: IMemoryAddress,
    actualType: string,
    operation: "read" | "write",
  ) {
    const message = `Cannot ${operation} property at path [${
      address.path.join(", ")
    }] - expected object but found ${actualType}`;
    super(message);
    this.address = address;
    this.actualType = actualType;
  }

  from(space: MemorySpace) {
    // Return the same error instance as it doesn't use space in the message
    return this;
  }
}

export class StateInconsistency extends RangeError
  implements IStorageTransactionInconsistent {
  override name = "StorageTransactionInconsistent" as const;

  constructor(
    public source: {
      address: IMemoryAddress;
      expected?: JSONValue;
      actual?: JSONValue;
      space?: MemorySpace;
    },
  ) {
    const { address, space, expected, actual } = source;
    const message = [
      `Transaction consistency violated: The "${address.type}" of "${address.id}" at "${
        address.path.join(".")
      }"`,
      space ? ` in space "${space}"` : "",
      ` hash changed. Previously it used to be:\n `,
      expected === undefined ? "undefined" : JSON.stringify(expected),
      "\n and currently it is:\n ",
      actual === undefined ? "undefined" : JSON.stringify(actual),
    ].join("");

    super(message);
  }
  get address() {
    return this.source.address;
  }

  from(space: MemorySpace) {
    return new StateInconsistency({
      ...this.source,
      space,
    });
  }
}
