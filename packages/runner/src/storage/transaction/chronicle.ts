import { deepEqual } from "@commontools/utils/deep-equal";
import { normalizeFact, unclaimed } from "@commontools/memory/fact";
import { toDeepStorableValue } from "../../value-codec.ts";
import type {
  Assertion,
  IAttestation,
  IInvalidDataURIError,
  IMemoryAddress,
  INotFoundError,
  IReadOnlyAddressError,
  ISpaceReplica,
  IStorageTransactionInconsistent,
  ITransaction,
  ITypeMismatchError,
  IUnsupportedMediaTypeError,
  MemorySpace,
  Result,
  State,
} from "../interface.ts";
import type {
  StorableDatum,
  StorableValue,
} from "@commontools/memory/interface";
import * as Address from "./address.ts";
import {
  attest,
  claim,
  InvalidDataURIError,
  load,
  NotFound,
  read,
  TypeMismatchError,
  UnsupportedMediaTypeError,
  write,
} from "./attestation.ts";
import { refer } from "@commontools/memory/reference";
import * as Edit from "./edit.ts";

export const open = (replica: ISpaceReplica) => new Chronicle(replica);

export {
  InvalidDataURIError,
  NotFound,
  TypeMismatchError,
  UnsupportedMediaTypeError,
};

export const ReadOnlyAddressError = (
  address: IMemoryAddress,
): IReadOnlyAddressError => ({
  name: "ReadOnlyAddressError",
  message: `Cannot write to read-only address: ${address.id}`,
  address,
  from(_space: MemorySpace) {
    return this;
  },
});

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
   * Loads the fact at the passed memory address from the underlying replica.
   * If fact is not found in the replica, return unclaimed state assuming no
   * such fact exists yet.
   */
  load(address: Omit<IMemoryAddress, "path">): State {
    // If we have not read nor written into overlapping memory address,
    // we'll read it from the local replica.
    return this.#replica.get(address) ??
      unclaimed({ of: address.id, the: address.type });
  }

  /**
   * Takes an invariant and applies all the changes that were written to this
   * chonicle that fall under the given source.
   *
   * This is really filtering the entries in `#novelty` for those that are
   * children of the source address, and returning the result of applying all
   * those changes to the source value.
   *
   * This does not modify source, but if there are no changes, we return
   * source, so we may need to avoid modifying the returned value.
   */
  rebase(source: IAttestation): Result<
    IAttestation,
    IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
  > {
    const changes = this.#novelty.select(source.address);
    return changes ? changes.rebase(source) : { ok: source };
  }

  /**
   * This does some validation to ensure that the write is applicable to the
   * state in the replica, and if it is, it adds this change to the set of
   * claims in the `#novelty` map.
   *
   * CT-1123: Simplified to use working copy pattern. Instead of loading and
   * rebasing on every write (O(N²)), we initialize a working copy once and
   * apply writes directly to it (O(N)).
   *
   * @param address the address for the value being written
   * @param value the value to add to the #novelty map
   * @returns a Result containing the new attestation or error
   */
  write(
    address: IMemoryAddress,
    value?: StorableDatum,
  ): Result<
    IAttestation,
    | IStorageTransactionInconsistent
    | IReadOnlyAddressError
    | INotFoundError
    | ITypeMismatchError
  > {
    // Check if address is inline (data: URI) - these are read-only
    if (Address.isInline(address)) {
      return { error: ReadOnlyAddressError(address) };
    }

    // Get or create the Changes object for this document
    const changes = this.#novelty.edit(address);

    // Initialize working copy from replica if needed (only happens once per document)
    if (!changes.getWorkingCopy()) {
      const state = this.load({ id: address.id, type: address.type });
      const loaded = attest(state);
      changes.initFromReplica(loaded);
    }

    // Get the current working copy state
    const workingCopy = changes.getWorkingCopy()!;

    // Check if document exists when trying to write to nested path
    if (workingCopy.value === undefined && address.path.length > 0) {
      const path = workingCopy.address.path;
      return {
        error: NotFound(
          workingCopy,
          address,
          path.length > 0 ? path.slice(0, -1) : [],
        ),
      };
    }

    // Apply the write directly to the working copy - O(1) instead of O(N)
    return changes.applyWrite(address, value);
  }

  read(
    address: IMemoryAddress,
    _options?: { meta?: unknown },
  ): Result<
    IAttestation,
    | IStorageTransactionInconsistent
    | IInvalidDataURIError
    | IUnsupportedMediaTypeError
    | INotFoundError
    | ITypeMismatchError
  > {
    // Handle data URIs
    if (Address.isInline(address)) {
      const { ok: attestation, error } = load(address);
      if (error) {
        return { error };
      } else {
        return read(attestation, address);
      }
    }

    // Check if we previously wrote to this exact path or a parent path
    const written = this.#novelty.get(address);
    if (written) {
      return read(written, address);
    }

    // No matching writes - read from the replica
    const state = this.load(address);

    // Check if document exists when trying to read from nested path
    if (state.is === undefined && address.path.length > 0) {
      return { error: NotFound(attest(state), address, []) };
    }

    const loaded = attest(state);
    const { error, ok: invariant } = read(loaded, address);
    if (error) {
      // If the read failed because of path errors, this is still effectively a
      // read, so let's log it for validation at commit
      if (
        error.name === "NotFoundError" || error.name === "TypeMismatchError"
      ) {
        this.#history.put(loaded);
      }
      return { error };
    } else {
      // Capture the original replica read in history (for validation at commit)
      this.#history.put(invariant);

      // Apply any overlapping writes from novelty and return merged result
      const changes = this.#novelty.select(address);
      const workingCopy = changes?.getWorkingCopy();
      if (workingCopy) {
        return read(workingCopy, address);
      }

      return { ok: invariant };
    }
  }

  /**
   * Attempts to derives transaction that can be commited to an underlying
   * replica. Function fails with {@link IStorageTransactionInconsistent} if
   * this contains somer read invariant that no longer holds, that is same
   * read produces different result.
   *
   * CT-1123: Simplified to use working copy directly instead of rebasing.
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

      // Get the working copy directly - no more O(N) rebase
      const merged = changes.getWorkingCopy();
      if (!merged) {
        // No working copy means no writes - shouldn't happen but handle gracefully
        continue;
      }

      if (merged.value === loaded.is) {
        // Fast path: reference equality means no change needed.
        edit.claim(loaded);
      } else {
        // Normalize both values for comparison and potential storage.
        const normalizedMerged = toDeepStorableValue(merged.value);
        const normalizedLoaded = toDeepStorableValue(loaded.is);

        if (deepEqual(normalizedMerged, normalizedLoaded)) {
          // Values are deeply equal after normalization - no change needed.
          edit.claim(loaded);
        } else if (normalizedMerged === undefined) {
          // If the normalized value is `undefined`, retract the fact.
          edit.retract(loaded as Assertion);
        } else {
          // Create an assertion referring to the loaded fact in a causal
          // reference.
          const factToRefer = loaded.cause ? normalizeFact(loaded) : loaded;
          const causeRef = refer(factToRefer);

          edit.assert({
            ...loaded,
            is: normalizedMerged as StorableDatum,
            cause: causeRef,
          });
        }
      }
    }

    return { ok: edit.build() };
  }
}

/**
 * History is essentially a map whose keys are the id, type, and path triple
 * whose values are the IAttestation for that key.
 */
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
      if (Address.includes(invariant.address, address)) {
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

  put(attestation: IAttestation) {
    const key = Address.toString(attestation.address);
    // Only store the first read - subsequent reads at the same address are ignored
    // This ensures commit-time validation uses the original snapshot
    if (!this.#model.has(key)) {
      this.#model.set(key, attestation);
    }
  }
}

/**
 * Novelty is essentially a map whose keys are the id and type pair and whose
 * values are the Changes associated with that key.
 */
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
  ): Result<
    IAttestation,
    IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
  > {
    const candidates = this.edit(invariant.address);

    for (const candidate of candidates) {
      // If the candidate is a parent of the new invariant, merge the new invariant
      // into the existing parent invariant.
      if (Address.includes(candidate.address, invariant.address)) {
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

    // If we did not find any parents we may have some children
    // that will be replaced by this invariant
    // Since we are altering the collection, we iterate over a copy.
    for (const candidate of [...candidates]) {
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

  /**
   * Returns true if there are any changes tracked in novelty.
   * Used for early exit optimization in commit().
   */
  hasChanges(): boolean {
    return this.#model.size > 0;
  }

  *changes(): Iterable<IAttestation> {
    for (const changes of this) {
      yield* changes;
    }
  }

  /**
   * Returns changes for the fact at the provided address.
   */
  select(address: IMemoryAddress) {
    return this.#model.get(`${address.id}/${address.type}`);
  }
}

/**
 * Changes tracks modifications to a single document using a "working copy" pattern.
 *
 * Instead of storing individual path writes and replaying them on every read/write
 * (which was O(N²)), we maintain a single merged state that gets updated directly.
 *
 * CT-1123: This eliminates the O(N²) behavior where N writes each replayed all
 * previous writes via rebase().
 */
class Changes {
  /** The current merged state of all writes to this document */
  #workingCopy: IAttestation | undefined;
  /** Individual path attestations for novelty() iterator (backwards compatibility) */
  #pathAttestations: Map<string, IAttestation> = new Map();
  address: IMemoryAddress;

  constructor(address: Omit<IMemoryAddress, "path">) {
    this.address = { ...address, path: [] };
  }

  /**
   * Initialize the working copy from replica data.
   * Called on first access to ensure we have a base to apply writes to.
   */
  initFromReplica(loaded: IAttestation): void {
    if (!this.#workingCopy) {
      this.#workingCopy = loaded;
    }
  }

  /**
   * Get the attestation covering the requested path.
   * Returns the working copy if we have a write at or above the requested path.
   */
  get(at: IMemoryAddress["path"]): IAttestation | undefined {
    if (!this.#workingCopy) return undefined;

    // Check if any written path is a prefix of or equal to the requested path
    for (const invariant of this.#pathAttestations.values()) {
      // For exact match or if invariant is parent of requested path
      if (invariant.address.path.every((p, i) => p === at[i])) {
        // Return the working copy which has the merged state
        return this.#workingCopy;
      }
    }
    return undefined;
  }

  /**
   * Apply a write directly to the working copy - O(1) amortized.
   * This replaces the old put() + rebase() pattern that was O(N).
   */
  applyWrite(
    address: IMemoryAddress,
    value: StorableValue,
  ): Result<
    IAttestation,
    IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
  > {
    if (!this.#workingCopy) {
      return {
        error: {
          name: "StorageTransactionInconsistent",
          message: "Cannot apply write without initialized working copy",
          address,
          from: () => ({
            name: "StorageTransactionInconsistent",
            message: "Cannot apply write without initialized working copy",
            address,
            from: function () {
              return this;
            },
          }),
        },
      };
    }

    const result = write(this.#workingCopy, address, value);
    if (result.ok) {
      this.#workingCopy = result.ok;
      // Store individual path attestation for novelty() iterator
      const pathKey = JSON.stringify(address.path);
      this.#pathAttestations.set(pathKey, { address, value });
    }
    return result;
  }

  /** Legacy put() for compatibility - applies write to working copy */
  put(invariant: IAttestation) {
    if (!this.#workingCopy) {
      // First write initializes the working copy
      this.#workingCopy = invariant;
    } else {
      // Apply write to working copy
      const result = write(
        this.#workingCopy,
        invariant.address,
        invariant.value,
      );
      if (result.ok) {
        this.#workingCopy = result.ok;
      }
    }
    // Store individual path attestation for novelty() iterator
    const pathKey = JSON.stringify(invariant.address.path);
    this.#pathAttestations.set(pathKey, invariant);
  }

  /** Legacy delete() - removes from path attestations */
  delete(invariant: IAttestation) {
    const pathKey = JSON.stringify(invariant.address.path);
    this.#pathAttestations.delete(pathKey);
  }

  /**
   * Get the working copy. Used for commit and reads.
   */
  getWorkingCopy(): IAttestation | undefined {
    return this.#workingCopy;
  }

  /**
   * Returns the working copy as the rebased result.
   * With the working copy pattern, no replay is needed - O(1).
   *
   * CT-1123: This was the O(N²) hotspot - each call iterated all changes
   * and deep-cloned. Now it just returns the already-merged state.
   */
  rebase(
    source: IAttestation,
  ): Result<
    IAttestation,
    IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
  > {
    if (this.#workingCopy) {
      return { ok: this.#workingCopy };
    }
    // If no working copy, return the source unchanged
    return { ok: source };
  }

  *[Symbol.iterator](): IterableIterator<IAttestation> {
    // If there's a write to root path [], yield the merged working copy
    // Otherwise, yield individual path attestations (old behavior for non-root writes)
    const hasRootWrite = this.#pathAttestations.has(JSON.stringify([]));
    if (hasRootWrite && this.#workingCopy) {
      yield this.#workingCopy;
    } else {
      yield* this.#pathAttestations.values();
    }
  }
}
