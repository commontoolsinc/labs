import type {
  IMemoryAddress,
  INotFoundError,
  ISpaceReplica,
  IStorageTransactionInconsistent,
  ITransaction,
  ITransactionInvariant,
  JSONValue,
  MemorySpace,
  Result,
  Unit,
} from "../interface.ts";
import * as TransactionInvariant from "./invariant.ts";
import { unclaimed } from "@commontools/memory/fact";
import { refer } from "merkle-reference";
import * as Edit from "./edit.ts";

export const open = (replica: ISpaceReplica) => new Chronicle(replica);

class Chronicle {
  #replica: ISpaceReplica;
  #history: History;
  #novelty: Novelty;

  constructor(replica: ISpaceReplica) {
    this.#replica = replica;
    this.#history = new History(replica.did());
    this.#novelty = new Novelty(replica.did());
  }
  did() {
    return this.#replica.did();
  }

  novelty() {
    return this.#novelty.changes();
  }

  *history() {
    yield* this.#history;
  }

  /**
   * Applies all the overlapping write invariants onto a given source invariant.
   */
  rebase(source: ITransactionInvariant) {
    const changes = this.#novelty.select(source.address);
    return changes ? changes.rebase(source) : { ok: source };
  }

  write(address: IMemoryAddress, value?: JSONValue) {
    return this.#novelty.claim({ address, value });
  }

  load(address: Omit<IMemoryAddress, "path">) {
    const [the, of] = [address.type, address.id];
    // If we have not read nor written into overlapping memory address so
    // we'll read it from the local replica.
    return this.#replica.get({ the, of }) ?? unclaimed({ the, of });
  }
  read(
    address: IMemoryAddress,
  ): Result<
    ITransactionInvariant,
    INotFoundError | IStorageTransactionInconsistent
  > {
    // If we previously wrote into overlapping memory address we simply
    // read from it.
    const written = this.#novelty.get(address);
    if (written) {
      return TransactionInvariant.read(written, address);
    }

    // If we previously read overlapping memory address we can read from it
    // and apply our writes on top.
    const prior = this.#history.get(address);
    if (prior) {
      const { error, ok: merged } = this.rebase(prior);
      if (error) {
        return { error };
      } else {
        return TransactionInvariant.read(merged, address);
      }
    }

    // If we have not read nor written into overlapping memory address so
    // we'll read it from the local replica.
    const loaded = TransactionInvariant.from(this.load(address));
    const { error, ok: invariant } = TransactionInvariant.read(loaded, address);
    if (error) {
      return { error };
    } else {
      // Capture the original replica read in history (for validation)
      const { error } = this.#history.claim(invariant);
      if (error) {
        return { error };
      }

      // Apply any overlapping writes from novelty and return merged result
      const { error: rebaseError, ok: merged } = this.rebase(invariant);
      if (rebaseError) {
        return { error: rebaseError };
      } else {
        return TransactionInvariant.read(merged, address);
      }
    }
  }

  /**
   * Attempts to derives transaction that can be commited to an underlying
   * replica. Function fails with {@link IStorageTransactionInconsistent} if
   * this contains somer read invariant that no longer holds, that is same
   * read produces different result.
   */
  commit(): Result<
    ITransaction,
    IStorageTransactionInconsistent | INotFoundError
  > {
    const edit = Edit.create();
    const replica = this.#replica;
    // Go over all read invariants, verify their consistency and add them as
    // edit claims.
    for (const invariant of this.history()) {
      const { ok: state, error } = TransactionInvariant.claim(
        invariant,
        replica,
      );

      if (error) {
        return { error };
      } else {
        edit.claim(state);
      }
    }

    for (const changes of this.#novelty) {
      const loaded = this.load(changes.address);
      const source = TransactionInvariant.from(loaded);
      const { error, ok: merged } = changes.rebase(source);
      if (error) {
        return { error };
      } //
      // If merged value is `undefined` and loaded fact was retraction
      // we simply claim loaded state. Otherwise we retract loaded fact
      else if (merged.value === undefined) {
        if (loaded.is === undefined) {
          edit.claim(loaded);
        } else {
          edit.retract(loaded);
        }
      } //
      // If merged value is not `undefined` we create an assertion referring
      // to the loaded fact in a causal reference.
      else {
        edit.assert({
          ...loaded,
          is: merged.value,
          cause: refer(loaded),
        });
      }
    }

    return { ok: edit.build() };
  }
}

class History {
  #model: Map<string, ITransactionInvariant> = new Map();
  #space: MemorySpace;
  constructor(space: MemorySpace) {
    this.#space = space;
  }

  get space() {
    return this.#space;
  }
  *[Symbol.iterator]() {
    yield* this.#model.values();
  }

  /**
   * Gets {@link TransactionInvariant} for the given `address` from which we
   * could read out the value. Note that returned invariant may not have exact
   * same `path` as the provided by the address, but if one is returned it will
   * have either exact same path or a parent path.
   *
   * @example
   * ```ts
   * const alice = {
   *    address: { id: 'user:1', type: 'application/json', path: ['profile'] }
   *    value: { name: "Alice", email: "alice@web.mail" }
   * }
   * const history = new MemorySpaceHistory()
   * history.put(alice)
   *
   * history.get(alice.address) === alice
   * // Lookup nested path still returns `alice`
   * history.get({
   *  id: 'user:1',
   *  type: 'application/json',
   *  path: ['profile', 'name']
   * }) === alice
   * ```
   */
  get(address: IMemoryAddress) {
    const at = TransactionInvariant.toKey(address);
    let candidate: undefined | ITransactionInvariant = undefined;
    for (const invariant of this) {
      const key = TransactionInvariant.toKey(invariant.address);
      // If `address` is contained in inside an invariant address it is a
      // candidate invariant. If this candidate has longer path than previous
      // candidate this is a better match so we pick this one.
      if (at.startsWith(key)) {
        if (!candidate) {
          candidate = invariant;
        } else if (
          candidate.address.path.length < invariant.address.path.length
        ) {
          candidate = invariant;
        }
      }
    }

    return candidate;
  }

  /**
   * Claims an new read invariant while ensuring consistency with all the
   * privous invariants.
   */
  claim(
    invariant: ITransactionInvariant,
  ): Result<ITransactionInvariant, IStorageTransactionInconsistent> {
    const at = TransactionInvariant.toKey(invariant.address);

    // Track which invariants to delete after consistency check
    const obsolete = new Set<string>();

    for (const candidate of this) {
      const key = TransactionInvariant.toKey(candidate.address);
      // If we have an existing invariant that is either child or a parent of
      // the new one two must be consistent with one another otherwise we are in
      // an inconsistent state.
      if (at.startsWith(key) || key.startsWith(at)) {
        // Always read at the more specific (longer) path for consistency check
        const address = at.length > key.length
          ? { ...invariant.address, space: this.space }
          : { ...candidate.address, space: this.space };

        const expect = TransactionInvariant.read(candidate, address).ok?.value;
        const actual = TransactionInvariant.read(invariant, address).ok?.value;

        if (JSON.stringify(expect) !== JSON.stringify(actual)) {
          return { error: new Inconsistency([candidate, invariant]) };
        }

        // If consistent, determine which invariant(s) to keep
        if (at === key) {
          // Same exact address - replace the existing invariant
          // No need to mark as obsolete, just overwrite
          continue;
        } else if (at.startsWith(key)) {
          // New invariant is a child of existing candidate (candidate is parent)
          // Drop the child invariant as it's redundant with the parent
          obsolete.add(at);
        } else if (key.startsWith(at)) {
          // New invariant is a parent of existing candidate (candidate is child)
          // Delete the child candidate as it's redundant with the new parent
          obsolete.add(key);
        }
      }
    }

    if (!obsolete.has(at)) {
      this.#model.set(at, invariant);
    }

    // Delete redundant child invariants
    for (const key of obsolete) {
      this.#model.delete(key);
    }

    return { ok: invariant };
  }
}

const NONE = Object.freeze(new Map());

class Novelty {
  #model: Map<string, Changes> = new Map();
  #space: MemorySpace;
  constructor(space: MemorySpace) {
    this.#space = space;
  }

  get did() {
    return this.#space;
  }

  edit(address: IMemoryAddress) {
    const key = `${address.id}/${address.type}`;
    const changes = this.#model.get(key);
    if (changes) {
      return changes;
    } else {
      const changes = new Changes(address);
      this.#model.set(key, changes);
      return changes;
    }
  }
  get(address: IMemoryAddress) {
    return this.select(address)?.get(address.path);
  }

  /**
   * Claims a new write invariant, merging it with existing parent invariants
   * when possible instead of keeping both parent and child separately.
   */
  claim(
    invariant: ITransactionInvariant,
  ): Result<ITransactionInvariant, INotFoundError> {
    const at = TransactionInvariant.toKey(invariant.address);
    const candidates = this.edit(invariant.address);

    for (const candidate of candidates) {
      // If the candidate is a parent of the new invariant, merge the new invariant
      // into the existing parent invariant.
      if (TransactionInvariant.includes(invariant.address, candidate.address)) {
        const { error, ok: merged } = TransactionInvariant.write(
          candidate,
          invariant.address,
          invariant.value,
        );

        if (error) {
          return { error };
        } else {
          candidates.put(merged);
          return { ok: merged };
        }
      }
    }

    // If we did not found any parents we may have some children
    // that will be replaced by this invariant
    for (const candidate of candidates) {
      if (TransactionInvariant.includes(invariant.address, candidate.address)) {
        candidates.delete(candidate);
      }
    }

    // Store this invariant
    candidates.put(invariant);

    return { ok: invariant };
  }

  [Symbol.iterator]() {
    return this.#model.values();
  }

  *changes() {
    for (const changes of this) {
      yield* changes;
    }
  }

  /**
   * Returns changes for the fact provided address links to.
   */
  select(address: IMemoryAddress) {
    return this.#model.get(`${address.id}/${address.type}`);
  }
}

class Changes {
  #model: Map<string, ITransactionInvariant> = new Map();
  address: IMemoryAddress;
  constructor(address: Omit<IMemoryAddress, "path">) {
    this.address = { ...address, path: [] };
  }

  get(at: IMemoryAddress["path"]) {
    let candidate: undefined | ITransactionInvariant = undefined;
    for (const invariant of this.#model.values()) {
      // Check if invariant's path is a prefix of requested path
      const path = invariant.address.path.join("/");

      // For exact match or if invariant is parent of requested path
      if (at.join("/").startsWith(path)) {
        const size = invariant.address.path.length;
        if (candidate?.address?.path?.length ?? -1 < size) {
          candidate = invariant;
        }
      }
    }

    return candidate;
  }

  put(invariant: ITransactionInvariant) {
    this.#model.set(invariant.address.path.join("/"), invariant);
  }
  delete(invariant: ITransactionInvariant) {
    this.#model.delete(invariant.address.path.join("/"));
  }

  /**
   * Applies all the overlapping write invariants onto a given source invariant.
   */

  rebase(source: ITransactionInvariant) {
    let merged = source;
    for (const change of this.#model.values()) {
      if (TransactionInvariant.includes(change.address, source.address)) {
        const { error, ok } = TransactionInvariant.write(
          merged,
          change.address,
          change.value,
        );
        if (error) {
          return { error };
        } else {
          merged = ok;
        }
      }
    }

    return { ok: merged };
  }

  [Symbol.iterator]() {
    return this.#model.values();
  }
}

export class Inconsistency extends RangeError
  implements IStorageTransactionInconsistent {
  override name = "StorageTransactionInconsistent" as const;
  constructor(public inconsitencies: ITransactionInvariant[]) {
    const details = [`Transaction consistency guarntees have being violated:`];
    for (const { address, value } of inconsitencies) {
      details.push(
        `  - The ${address.type} of ${address.id} at ${
          address.path.join(".")
        } has value ${JSON.stringify(value)}`,
      );
    }

    super(details.join("\n"));
  }
}
