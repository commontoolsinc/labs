import type {
  Fact,
  IMemoryAddress,
  INotFoundError,
  ISpaceReplica,
  IStorageTransactionInconsistent,
  ITransactionInvariant,
  JSONValue,
  MemorySpace,
  Result,
  State,
} from "../interface.ts";
import { assert, retract, unclaimed } from "@commontools/memory/fact";
import { refer } from "merkle-reference";
import { Inconsistency } from "./chronicle.ts";
export const toKey = (address: IMemoryAddress) =>
  `/${address.id}/${address.type}/${address.path.join("/")}`;

/**
 * Takes `source` invariant, `address` and `value` and produces derived
 * invariant with `value` set to a property that given `address` leads to
 * in the `source`. Fails if address leads to a non-object target.
 */
export const write = (
  source: ITransactionInvariant,
  address: IMemoryAddress,
  value: JSONValue | undefined,
): Result<ITransactionInvariant, INotFoundError> => {
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
          error: new NotFound(
            { address: { ...address, path }, value },
            address,
          ),
        };
      }
    }
  }
};

/**
 * Reads requested `address` from the provided `source` and either succeeds and
 * returns derived {@link ITransactionInvariant} with the given `address` or
 * fails when key in the address path accessed on a non-object parent. Note it
 * will succeed with `undefined` value when last key in the path leads to
 * non-existing property of the object. Below are some examples illustrating
 * read behavior
 *
 * ```ts
 * const address = {
 *   id: "test:1",
 *   type: "application/json",
 *   path: [],
 *   space: "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi"
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
  source: ITransactionInvariant,
  address: IMemoryAddress,
) => resolve(source, address);

export const from = ({ the, of, is }: State): ITransactionInvariant => {
  return {
    address: { id: of, type: the, path: [] },
    value: is,
  };
};

/**
 * Verifies consistency of the expected invariant in the given replica. If
 * expected invariant holds succeeds with a state of the fact in the given
 * replica otherwise fails with `IStorageTransactionInconsistent` error.
 */
export const claim = (
  expected: ITransactionInvariant,
  replica: ISpaceReplica,
): Result<State, IStorageTransactionInconsistent> => {
  const [the, of] = [expected.address.type, expected.address.id];
  const state = replica.get({ the, of }) ?? unclaimed({ the, of });
  const source = {
    address: { ...expected.address, path: [] },
    value: state.is,
  };
  const actual = read(source, expected.address)?.ok;
  // If read invariant is
  if (JSON.stringify(expected.value) === JSON.stringify(actual?.value)) {
    return { ok: state };
  } else {
    return { error: new Inconsistency([source, expected]) };
  }
};

/**
 * Produces updated state of the address fact by applying a change.
 */
export const upsert = (
  change: ITransactionInvariant,
  replica: ISpaceReplica,
): Result<State, INotFoundError> => {
  const [the, of] = [change.address.type, change.address.id];
  const state = replica.get({ the, of }) ?? unclaimed({ the, of });
  const source = {
    address: { ...change.address, path: [] },
    value: state.is,
  };

  const { error, ok: merged } = write(source, change.address, change.value);
  if (error) {
    return { error };
  } else {
    // If change removes the fact we either retract it or if it was
    // already retracted we just claim current state.
    if (merged.value === undefined) {
      if (state.is === undefined) {
        return { ok: state };
      } else {
        return { ok: retract(state) };
      }
    } else {
      return {
        ok: assert({
          the: state.the,
          of: state.of,
          is: merged.value,
          cause: refer(state),
        }),
      };
    }
  }
};

export const resolve = (
  source: ITransactionInvariant,
  address: IMemoryAddress,
): Result<ITransactionInvariant, INotFoundError> => {
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
        error: new NotFound({
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

/**
 * Returns true if `candidate` address references location within the
 * the `source` address. Otherwise returns false.
 */
export const includes = (
  source: IMemoryAddress,
  candidate: IMemoryAddress,
) =>
  source.id === candidate.id &&
  source.type === candidate.type &&
  source.path.join("/").startsWith(candidate.path.join("/"));

export class NotFound extends RangeError implements INotFoundError {
  override name = "NotFoundError" as const;

  constructor(
    public source: ITransactionInvariant,
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
