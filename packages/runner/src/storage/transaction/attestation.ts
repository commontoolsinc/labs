import { deepEqual } from "@commontools/utils/deep-equal";
import { isRecord } from "@commontools/utils/types";
import { isArrayIndexPropertyName } from "@commontools/memory/storable-value";
import type {
  StorableDatum,
  StorableObject,
  StorableValue,
} from "@commontools/memory/interface";
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
import { unclaimed } from "@commontools/memory/fact";
import { getLogger } from "@commontools/utils/logger";
import { LRUCache } from "@commontools/utils/cache";

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
 * Sets a value at path using structural sharing. Only clones along the path.
 * Returns original reference if nothing changed (noop propagation).
 *
 * CT-1123 Phase 2: This replaces the O(N) JSON.parse(JSON.stringify()) deep clone
 * with O(D) structural sharing where D is path depth.
 */
const setAtPath = (
  root: StorableValue,
  path: readonly MemoryAddressPathComponent[],
  value: StorableValue,
): { ok: StorableValue } | {
  error: { at: number; type: string; notFound?: boolean };
} => {
  // Base case: empty path = replace root
  if (path.length === 0) {
    return { ok: value };
  }

  const [key, ...rest] = path;

  // Type check: can't traverse through non-objects
  if (root === null || root === undefined || typeof root !== "object") {
    // Distinguish between undefined (path not found) vs primitive (type mismatch)
    if (root === undefined) {
      // Return at: -1 to indicate the error is at the parent level (the key that
      // led here doesn't exist). After +1 adjustments during unwinding, this
      // produces a path that includes the missing key, matching read semantics.
      return { error: { at: -1, type: "undefined", notFound: true } };
    }
    const actualType = root === null ? "null" : typeof root;
    return { error: { at: 0, type: actualType } };
  }

  // Handle arrays
  if (Array.isArray(root)) {
    // Special: array.length property
    if (key === "length" && rest.length === 0) {
      const newLen = value as number;
      if (root.length === newLen) return { ok: root }; // noop
      // Use slice for truncation, negative values, and non-finite values (NaN, Infinity)
      // slice handles these edge cases correctly and matches previous behavior
      if (newLen < root.length || newLen < 0 || !Number.isFinite(newLen)) {
        return { ok: root.slice(0, newLen) };
      } else {
        // Extension: create array with new length (sparse slots become undefined in JSON)
        const extended = [...root];
        extended.length = newLen;
        return { ok: extended };
      }
    }

    // Validate array key
    if (!isArrayIndexPropertyName(key)) {
      return { error: { at: 0, type: "array" } };
    }

    const index = Number(key);

    // Terminal case
    if (rest.length === 0) {
      if (root[index] === value) return { ok: root }; // noop
      const newArray = [...root];
      if (value === undefined) {
        delete newArray[index]; // creates hole, not splice
      } else {
        newArray[index] = value;
      }
      return { ok: newArray };
    }

    // Recursive case
    const nested = root[index];
    const result = setAtPath(nested, rest, value);
    if ("error" in result) {
      return {
        error: {
          at: result.error.at + 1,
          type: result.error.type,
          notFound: result.error.notFound,
        },
      };
    }
    if (result.ok === nested) return { ok: root }; // noop propagation
    const newArray = [...root];
    newArray[index] = result.ok as StorableDatum;
    return { ok: newArray };
  }

  // Handle objects
  const obj = root as StorableObject;

  // Terminal case
  if (rest.length === 0) {
    if (obj[key] === value) return { ok: root }; // noop
    if (value === undefined) {
      if (!(key in obj)) return { ok: root }; // delete non-existent = noop
      const { [key]: _, ...without } = obj;
      return { ok: without as StorableDatum };
    }
    return { ok: { ...obj, [key]: value } };
  }

  // Recursive case
  const nested = obj[key];
  const result = setAtPath(nested, rest, value);
  if ("error" in result) {
    return {
      error: {
        at: result.error.at + 1,
        type: result.error.type,
        notFound: result.error.notFound,
      },
    };
  }
  if (result.ok === nested) return { ok: root }; // noop propagation
  return { ok: { ...obj, [key]: result.ok as StorableDatum } };
};

/**
 * Takes `source` attestation, `address` and `value` and produces derived
 * attestation with `value` set to a property that given `address` leads to
 * in the `source`. Fails with type mismatch error if provided `address` leads
 * to a non-object target, or NotFound error if the document doesn't exist.
 *
 * CT-1123 Phase 2: Now uses structural sharing via setAtPath() instead of
 * JSON.parse(JSON.stringify()) deep clone. Only clones objects along the
 * modified path, leaving siblings shared.
 */
export const write = (
  source: IAttestation,
  address: IMemoryAddress,
  value: StorableValue,
): Result<
  IAttestation,
  IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
> => {
  // Calculate relative path from source
  const relativePath = address.path.slice(source.address.path.length);

  // Root write: path lengths equal (empty relative path)
  if (relativePath.length === 0) {
    if (source.value === value) return { ok: source }; // noop
    return { ok: { ...source, value } };
  }

  // Can't write nested path on undefined document
  if (source.value === undefined) {
    return {
      error: NotFound(source, address, source.address.path),
    };
  }

  // Apply structural sharing via setAtPath
  const result = setAtPath(source.value, relativePath, value);

  if ("error" in result) {
    // Map error position to full address path
    // result.error.at is the depth where the error occurred; +1 to include the failed key
    const errorPath = address.path.slice(
      0,
      source.address.path.length + result.error.at + 1,
    );

    // Distinguish between NotFound (path doesn't exist) and TypeMismatch (wrong type)
    if (result.error.notFound) {
      // errorPath includes the missing key, matching read error semantics
      return {
        error: NotFound(source, address, errorPath),
      };
    }
    return {
      error: TypeMismatchError(
        { ...address, path: errorPath },
        result.error.type,
        "write",
      ),
    };
  }

  // Noop: setAtPath returns original reference if nothing changed
  if (result.ok === source.value) {
    return { ok: source };
  }

  return { ok: { ...source, value: result.ok } };
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
 *
 * Optimized to check reference equality before falling back to JSON.stringify
 * comparison, avoiding expensive hashing when the replica state is unchanged.
 */
export const claim = (
  { address, value: expected }: IAttestation,
  replica: ISpaceReplica,
): Result<State, IStorageTransactionInconsistent> => {
  const state = replica.get(address) ??
    unclaimed({ of: address.id, the: address.type });
  const source = attest(state);
  const actual = read(source, address)?.ok?.value;

  // Fast path: reference equality check avoids expensive comparison
  // when the replica state hasn't changed since the original read
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
      value = (value as StorableObject)[key];
    } else {
      // If the value is undefined, the path doesn't exist, but we can still
      // write onto it. Return error with last valid path component.
      if (value === undefined || value === null) {
        return {
          error: NotFound(source, address, path.slice(0, Math.max(0, at))),
        };
      }
      // Type mismatch - trying to access property on non-object
      return {
        error: TypeMismatchError(
          { ...address, path: path.slice(0, at + 1) },
          typeof value,
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
  const cacheKey = `${address.id}::${address.type}`;
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

        // Check if media type matches address.type
        if (mediaType !== address.type) {
          // Media type mismatch - return error
          result = {
            error: UnsupportedMediaTypeError(
              `Media type mismatch: expected "${address.type}" but data URI contains "${mediaType}"`,
            ),
          };
        } else if (mediaType === "application/json") {
          // Handle JSON media type
          let value: StorableDatum;
          try {
            value = JSON.parse(content);
            result = { ok: { address: { ...address, path: [] }, value } };
          } catch (error) {
            const reason = error as Error;
            result = {
              error: InvalidDataURIError(
                `Failed to parse JSON from data URI: ${reason.message}`,
              ),
            };
          }
        } else if (mediaType.startsWith("text/")) {
          // Handle other media types - store as string for now since we do not
          // support blobs yet.
          result = {
            ok: { address: { ...address, path: [] }, value: content },
          };
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
  expected?: StorableDatum;
  actual?: StorableDatum;
  space?: MemorySpace;
}): IStorageTransactionInconsistent => {
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
