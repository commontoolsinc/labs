import type {
  IAttestation,
  IMemoryAddress,
  INotFoundError,
  ISpaceReplica,
  IStorageTransactionInconsistent,
  JSONValue,
  MemorySpace,
  Result,
  State,
} from "../interface.ts";
import { unclaimed } from "@commontools/memory/fact";

/**
 * Takes `source` attestation, `address` and `value` and produces derived
 * attestation with `value` set to a property that given `address` leads to
 * in the `source`. Fails with inconsitency error if provided `address` leads
 * to a non-object target.
 */
export const write = (
  source: IAttestation,
  address: IMemoryAddress,
  value: JSONValue | undefined,
): Result<IAttestation, IStorageTransactionInconsistent> => {
  const path = address.path.slice(source.address.path.length);
  if (path.length === 0) {
    return { ok: { ...source, value } };
  } else {
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
      const type = ok.value === null ? "null" : typeof ok.value;
      if (type === "object") {
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
        return {
          error: new WriteInconsistency(
            { address: { ...address, path }, value },
            address,
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
) => resolve(source, address);

/**
 * Takes a source fact {@link State} and derives an attestion describing it's
 * state.
 */
export const attest = ({ the, of, is }: State): IAttestation => {
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
 * with inconsistency error if resolving an address encounters non-object along
 * the resolution path.
 */
export const resolve = (
  source: IAttestation,
  address: IMemoryAddress,
): Result<IAttestation, IStorageTransactionInconsistent> => {
  const { path } = address;
  let at = source.address.path.length - 1;
  let value = source.value;
  while (++at < path.length) {
    const key = path[at];
    if (typeof value === "object" && value != null) {
      // We do not support array.length as that is JS specific getter.
      value = Array.isArray(value) && key === "length"
        ? undefined
        : (value as Record<string, JSONValue>)[key];
    } else {
      return {
        error: new ReadInconsistency({
          address: {
            ...address,
            path: path.slice(0, at),
          },
          value,
        }, address),
      };
    }
  }

  return { ok: { value, address } };
};

export class NotFound extends RangeError implements INotFoundError {
  override name = "NotFoundError" as const;

  constructor(
    public source: IAttestation,
    public address: IMemoryAddress,
    public space?: MemorySpace,
  ) {
    const message = [
      `Can not resolve the "${address.type}" of "${address.id}" at "${
        address.path.join(".")
      }"`,
      space ? ` from "${space}"` : "",
      `, because encountered following non-object at ${
        source.address.path.join(".")
      }:`,
      source.value === undefined ? source.value : JSON.stringify(source.value),
    ].join("");

    super(message);
  }

  from(space: MemorySpace) {
    return new NotFound(this.source, this.address, space);
  }
}

export class WriteInconsistency extends RangeError
  implements IStorageTransactionInconsistent {
  override name = "StorageTransactionInconsistent" as const;

  constructor(
    public source: IAttestation,
    public address: IMemoryAddress,
    public space?: MemorySpace,
  ) {
    const message = [
      `Transaction consistency violated: cannot write the "${address.type}" of "${address.id}" at "${
        address.path.join(".")
      }"`,
      space ? ` in space "${space}"` : "",
      `. Write operation expected an object at path "${
        source.address.path.join(".")
      }" but encountered: ${
        source.value === undefined ? "undefined" : JSON.stringify(source.value)
      }`,
    ].join("");

    super(message);
  }

  from(space: MemorySpace) {
    return new WriteInconsistency(this.source, this.address, space);
  }
}

export class ReadInconsistency extends RangeError
  implements IStorageTransactionInconsistent {
  override name = "StorageTransactionInconsistent" as const;

  constructor(
    public source: IAttestation,
    public address: IMemoryAddress,
    public space?: MemorySpace,
  ) {
    const message = [
      `Transaction consistency violated: cannot read "${address.type}" of "${address.id}" at "${
        address.path.join(".")
      }"`,
      space ? ` in space "${space}"` : "",
      `. Read operation expected an object at path "${
        source.address.path.join(".")
      }" but encountered: ${
        source.value === undefined ? "undefined" : JSON.stringify(source.value)
      }`,
    ].join("");

    super(message);
  }

  from(space: MemorySpace) {
    return new ReadInconsistency(this.source, this.address, space);
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
