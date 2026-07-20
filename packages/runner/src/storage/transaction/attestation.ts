import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import {
  type FabricPlainObject,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import type {
  IAttestation,
  IInvalidDataURIError,
  IMemoryAddress,
  INotFoundError,
  ISpaceReplica,
  IStorageTransactionInconsistent,
  ITypeMismatchError,
  IUnsupportedMediaTypeError,
  MemoryAddressPathComponent,
  MemorySpace,
  Result,
  State,
} from "../interface.ts";
import { unclaimed } from "@commonfabric/memory/fact";
import { getLogger } from "@commonfabric/utils/logger";
import { LRUCache } from "@commonfabric/utils/cache";
import { toTransactionDocumentValue } from "../v2-document.ts";
import { decodeDataURIPayloadText } from "../../uri-utils.ts";

const logger = getLogger("attestation", {
  enabled: false,
  level: "debug",
});

const cacheHitLogger = getLogger("attestation-hit", {
  enabled: false,
  level: "debug",
});
/**
 * Cache for parsed data URIs to avoid redundant parsing.
 * Key format: `${address.id}::${address.type}`
 */
const dataURICache = new LRUCache<
  string,
  Result<IAttestation, IInvalidDataURIError | IUnsupportedMediaTypeError>
>({ capacity: 1000 });

export const InvalidDataURIError = (
  message: string,
  cause?: IInvalidDataURIError["cause"],
): IInvalidDataURIError => ({
  name: "InvalidDataURIError",
  message,
  cause,
  from(_space: MemorySpace) {
    return this;
  },
});

export const UnsupportedMediaTypeError = (
  message: string,
): IUnsupportedMediaTypeError => ({
  name: "UnsupportedMediaTypeError",
  message,
  from(_space: MemorySpace) {
    return this;
  },
});

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
export const attest = (
  { the, of, is, scope }: Omit<State, "cause"> & Pick<IMemoryAddress, "scope">,
): IAttestation => {
  return {
    address: { id: of, type: the, path: [], scope },
    value: is,
  };
};

/**
 * Verifies consistency of provided attestation with a given replica. If
 * current state matches provided attestation function succeeds with a state
 * of the fact in the given replica otherwise function fails with
 * `IStorageTransactionInconsistent` error.
 *
 * Optimized to check reference equality before falling back to JSON.stringify
 * comparison, avoiding expensive hashing when the replica state is unchanged.
 */
export const claim = (
  { address, value: expected }: IAttestation,
  replica: ISpaceReplica,
): Result<State, IStorageTransactionInconsistent> => {
  const type = address.type ?? "application/json";
  const state = replica.get(address) ??
    unclaimed({ of: address.id, the: type });
  const source = attest(state);
  const actual = type === "application/json" &&
      address.path.length === 0 &&
      typeof replica.getDocument === "function"
    ? toTransactionDocumentValue(
      replica.getDocument(address.id, address.scope),
    )
    : read(source, address)?.ok?.value;

  // Fast path: reference equality check avoids expensive comparison
  // when the replica state hasn't changed since the original read
  // TODO(danfuzz): This compares a stored document value (the read/attested
  // value) with `deepEqual`, which mishandles `FabricValue`: two same-class
  // `FabricPrimitive` values (state in private `#fields`, zero own-props)
  // compare equal regardless of value, so a changed Fabric value can be
  // mis-detected as unchanged. Use a Fabric-aware equality for stored-value
  // comparison.
  if (expected === actual || deepEqual(expected, actual)) {
    return { ok: state };
  } else {
    return {
      error: StateInconsistency({ address, expected, actual }),
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
      error: NotFound(
        source,
        address,
        // Return the source path (empty array for root). This is consistent with
        // how writes handle document-not-found. If source.address.path has content,
        // we slice off the last element since that's what points to undefined.
        source.address.path.length > 0 ? source.address.path.slice(0, -1) : [],
      ),
    };
  }

  while (++at < path.length) {
    const key = path[at];
    if (isRecord(value)) {
      value = (value as FabricPlainObject)[key];
    } else {
      // If the value is undefined, the path doesn't exist, but we can still
      // write onto it. Return error with last valid path component.
      if (value === undefined) {
        return {
          error: NotFound(source, address, path.slice(0, Math.max(0, at))),
        };
      }
      // Type mismatch - trying to access property on non-object
      const actualType = value === null ? "null" : typeof value;
      return {
        error: TypeMismatchError(
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
 * Results are cached to avoid redundant parsing of the same data URIs.
 */
export const load = (
  address: Omit<IMemoryAddress, "path">,
): Result<IAttestation, IInvalidDataURIError | IUnsupportedMediaTypeError> => {
  // Check cache first
  const cacheKey = address.id;
  const cached = dataURICache.get(cacheKey);
  if (cached) {
    cacheHitLogger.debug("cache-hit", "found cached result");
    return cached;
  }

  logger.debug("storage-datauri-parse", () => ["Parsing data URI"]);

  let result: Result<
    IAttestation,
    IInvalidDataURIError | IUnsupportedMediaTypeError
  >;

  try {
    // Parse data URI using URL constructor
    const url = new URL(address.id);

    if (url.protocol !== "data:") {
      result = {
        error: InvalidDataURIError(
          "Invalid data URI: protocol must be 'data:'",
        ),
      };
    } else {
      const [mediaTypeAndParams, data] = url.pathname.split(",");

      if (data === undefined) {
        result = {
          error: InvalidDataURIError(
            "Invalid data URI format: missing comma separator",
          ),
        };
      } else {
        // Parse media type and parameters
        const params = mediaTypeAndParams.split(";");
        const mediaType = params[0] || "text/plain";
        const isBase64 = params.includes("base64");

        // Decode data
        const content = isBase64 ? atob(data) : decodeURIComponent(data);

        if (mediaType === "application/json") {
          let value: FabricValue;
          try {
            value = decodeDataURIPayloadText(content);
            result = { ok: { address: { ...address, path: [] }, value } };
          } catch (error) {
            const reason = error as Error;
            result = {
              error: InvalidDataURIError(
                `Failed to parse JSON from data URI: ${reason.message}`,
              ),
            };
          }
        } else {
          result = {
            error: UnsupportedMediaTypeError(
              `Unsupported media type ${mediaType}`,
            ),
          };
        }
      }
    }
  } catch (error) {
    const reason = error as Error;
    result = {
      error: InvalidDataURIError(
        `Invalid data URI: ${reason.message}`,
      ),
    };
  }

  dataURICache.put(cacheKey, result);

  return result;
};

/**
 * Creates a NotFoundError.
 *
 * @param source - The attestation that was being read from or written to
 * @param address - The full address that was attempted
 * @param path - Path to the non-existent key (includes the missing key).
 *   Consistent for both reads and writes. See INotFoundError docs.
 */
export const NotFound = (
  source: IAttestation,
  address: IMemoryAddress,
  path: readonly MemoryAddressPathComponent[],
): INotFoundError => {
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

  return {
    name: "NotFoundError",
    message,
    source,
    address,
    path,
    from(_space: MemorySpace) {
      // Return the same error instance as it doesn't use space in the message
      return this;
    },
  };
};

export const TypeMismatchError = (
  address: IMemoryAddress,
  actualType: string,
  operation: "read" | "write",
): ITypeMismatchError => ({
  name: "TypeMismatchError",
  message: `Cannot ${operation} property at path [${
    address.path.join(", ")
  }] - expected object but found ${actualType}`,
  address,
  actualType,
  from(_space: MemorySpace) {
    // Return the same error instance as it doesn't use space in the message
    return this;
  },
});

export const StateInconsistency = (source: {
  address: IMemoryAddress;
  expected?: FabricValue;
  actual?: FabricValue;
  space?: MemorySpace;
}): IStorageTransactionInconsistent => {
  const { address, space, expected, actual } = source;
  const message = [
    `Transaction consistency violated: The "${address.type}" of "${address.id}" at "${
      address.path.join(".")
    }"`,
    space ? ` in space "${space}"` : "",
    ` hash changed. Previously it used to be:\n `,
    toCompactDebugString(expected),
    "\n and currently it is:\n ",
    toCompactDebugString(actual),
  ].join("");

  return {
    name: "StorageTransactionInconsistent",
    message,
    address,
    from(newSpace: MemorySpace) {
      return StateInconsistency({
        ...source,
        space: newSpace,
      });
    },
  };
};
