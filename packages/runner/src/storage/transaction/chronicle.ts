import type {
  IAttestation,
  IMemoryAddress,
  ISpaceReplica,
  IStorageTransactionInconsistent,
  ITransaction,
  JSONValue,
  MemorySpace,
  Result,
  State,
} from "../interface.ts";
import * as Address from "./address.ts";
import {
  attest,
  claim,
  read,
  StateInconsistency,
  write,
} from "./attestation.ts";
import { unclaimed } from "@commontools/memory/fact";
import { refer } from "merkle-reference";
import * as Edit from "./edit.ts";

export const open = (replica: ISpaceReplica) => new Chronicle(replica);

export class Chronicle {
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

  novelty(): Iterable<IAttestation> {
    return this.#novelty.changes();
  }

  *history(): Iterable<IAttestation> {
    yield* this.#history;
  }

  /**
   * Loads a fact correstate to passed memory address from the underlying
   * replica. If fact is not found in the replica return unclaimed state
   * assuming no such fact exists yet.
   */
  load(address: Omit<IMemoryAddress, "path">): State {
    const [the, of] = [address.type, address.id];
    // If we have not read nor written into overlapping memory address so
    // we'll read it from the local replica.
    return this.#replica.get({ the, of }) ?? unclaimed({ the, of });
  }

  /**
   * Takes an invariant and applies all the changes that were written to this
   * chonicle that fall under the given source.
   */
  rebase(source: IAttestation) {
    const changes = this.#novelty.select(source.address);
    return changes ? changes.rebase(source) : { ok: source };
  }

  write(address: IMemoryAddress, value?: JSONValue) {
    return this.#novelty.claim({ address, value });
  }

  read(
    address: IMemoryAddress,
  ): Result<IAttestation, IStorageTransactionInconsistent> {
    // If we previously wrote into overlapping memory address we simply
    // read from it.
    const written = this.#novelty.get(address);
    if (written) {
      return read(written, address);
    }

    // If we previously read overlapping memory address we can read from it
    // and apply our writes on top.
    const prior = this.#history.get(address);
    if (prior) {
      const { error, ok: merged } = this.rebase(prior);
      if (error) {
        return { error };
      } else {
        return read(merged, address);
      }
    }

    // If we have not read nor written into overlapping memory address so
    // we'll read it from the local replica.
    const loaded = attest(this.load(address));
    const { error, ok: invariant } = read(loaded, address);
    if (error) {
      return { error };
    } else {
      // Capture the original replica read in history (for validation)
      const claim = this.#history.claim(invariant);
      if (claim.error) {
        return claim;
      }

      // Apply any overlapping writes from novelty and return merged result
      const rebase = this.rebase(invariant);
      if (rebase.error) {
        return rebase;
      } else {
        return read(rebase.ok, address);
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
    IStorageTransactionInconsistent
  > {
    const edit = Edit.create();
    const replica = this.#replica;
    // Go over all read invariants, verify their consistency and add them as
    // edit claims.
    for (const invariant of this.history()) {
      const { ok: state, error } = claim(invariant, replica);

      if (error) {
        return { error };
      } else {
        edit.claim(state);
      }
    }

    for (const changes of this.#novelty) {
      const loaded = this.load(changes.address);
      const source = attest(loaded);
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
  #model: Map<string, IAttestation> = new Map();
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
   * Gets {@link Attestation} for the given `address` from which we
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
  get(address: IMemoryAddress): IAttestation | undefined {
    let candidate: undefined | IAttestation = undefined;
    for (const invariant of this) {
      // If `address` is contained in inside an invariant address it is a
      // candidate invariant. If this candidate has longer path than previous
      // candidate this is a better match so we pick this one.
      if (Address.includes(address, invariant.address)) {
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
    attestation: IAttestation,
  ): Result<IAttestation, IStorageTransactionInconsistent> {
    // Track which invariants to delete after consistency check
    const obsolete = new Set<IAttestation>();

    for (const candidate of this) {
      // If we have an existing invariant that is either child or a parent of
      // the new one two must be consistent with one another otherwise we are in
      // an inconsistent state.
      if (Address.intersect(attestation.address, candidate.address)) {
        // Always read at the more specific (longer) path for consistency check
        const address =
          attestation.address.path.length > candidate.address.path.length
            ? attestation.address
            : candidate.address;

        const expected = read(candidate, address).ok?.value;
        const actual = read(attestation, address).ok?.value;

        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          return {
            error: new StateInconsistency({
              address,
              expected,
              actual,
            }),
          };
        }

        // If consistent, determine which invariant(s) to keep
        if (attestation.address.path.length === candidate.address.path.length) {
          // Same exact address - replace the existing invariant
          // No need to mark as obsolete, just overwrite
          continue;
        } else if (candidate.address === address) {
          // New invariant is a child of existing candidate (candidate is parent)
          // Drop the child invariant as it's redundant with the parent
          obsolete.add(attestation);
        } else if (attestation.address === address) {
          // New invariant is a parent of existing candidate (candidate is child)
          // Delete the child candidate as it's redundant with the new parent
          obsolete.add(candidate);
        }
      }
    }

    if (!obsolete.has(attestation)) {
      this.put(attestation);
    }

    // Delete redundant child invariants
    for (const attestation of obsolete) {
      this.delete(attestation);
    }

    return { ok: attestation };
  }

  put(attestation: IAttestation) {
    this.#model.set(Address.toString(attestation.address), attestation);
  }
  delete(attestation: IAttestation) {
    this.#model.delete(Address.toString(attestation.address));
  }
}

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
    invariant: IAttestation,
  ): Result<IAttestation, IStorageTransactionInconsistent> {
    const candidates = this.edit(invariant.address);

    for (const candidate of candidates) {
      // If the candidate is a parent of the new invariant, merge the new invariant
      // into the existing parent invariant.
      if (Address.includes(invariant.address, candidate.address)) {
        const { error, ok: merged } = write(
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
      if (Address.includes(invariant.address, candidate.address)) {
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

  *changes(): Iterable<IAttestation> {
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
  #model: Map<string, IAttestation> = new Map();
  address: IMemoryAddress;
  constructor(address: Omit<IMemoryAddress, "path">) {
    this.address = { ...address, path: [] };
  }

  get(at: IMemoryAddress["path"]): IAttestation | undefined {
    let candidate: undefined | IAttestation = undefined;
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

  put(invariant: IAttestation) {
    this.#model.set(invariant.address.path.join("/"), invariant);
  }
  delete(invariant: IAttestation) {
    this.#model.delete(invariant.address.path.join("/"));
  }

  /**
   * Applies all the overlapping write invariants onto a given source invariant.
   */

  rebase(
    source: IAttestation,
  ): Result<IAttestation, IStorageTransactionInconsistent> {
    let merged = source;
    for (const change of this.#model.values()) {
      if (Address.includes(change.address, source.address)) {
        const { error, ok } = write(
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

  [Symbol.iterator](): IterableIterator<IAttestation> {
    return this.#model.values();
  }
}
