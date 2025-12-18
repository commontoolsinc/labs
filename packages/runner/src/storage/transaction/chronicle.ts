import { normalizeFact, unclaimed } from "@commontools/memory/fact";
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
  JSONValue,
  MemorySpace,
  Result,
  State,
} from "../interface.ts";
import * as Address from "./address.ts";
import {
  attest,
  claim,
  InvalidDataURIError,
  load,
  NotFound,
  read,
  StateInconsistency,
  TypeMismatchError,
  UnsupportedMediaTypeError,
  write,
} from "./attestation.ts";
import { refer } from "merkle-reference";
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
   * OPTIMIZATION (CT-1123): Merges writes immediately into a single root
   * attestation instead of storing individual path writes.
   *
   * @param address the address for the value being written
   * @param value the value to add to the #novelty map
   * @returns a Result containing the new attestation or error
   */
  write(
    address: IMemoryAddress,
    value?: JSONValue,
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

    // Load the fact from replica
    const state = this.load(address);
    const loaded = attest(state);

    // Get or create Changes for this document
    const changes = this.#novelty.edit(address);

    // Get the current merged state: either from existing novelty or from replica
    // This is the base we'll apply the write to
    const existingRoot = changes.getRoot();
    const baseState = existingRoot ?? loaded;

    // Check if document exists when trying to write to nested path
    // Only return NotFound if we're accessing a path on a non-existent document
    // and there's no novelty write that would have created it
    if (baseState.value === undefined && address.path.length > 0) {
      const path = baseState.address.path;
      return {
        error: NotFound(
          baseState,
          address,
          path.length > 0 ? path.slice(0, -1) : undefined,
        ),
      };
    }

    // Apply the write to the merged state
    const writeResult = write(baseState, address, value);
    if (writeResult.error) {
      return { error: writeResult.error };
    }

    // Store the merged root (writeResult.ok already has path: [] from baseState)
    // Track the written path for proper read short-circuiting
    changes.setRoot(writeResult.ok, address.path);

    // Return the merged root attestation
    return { ok: writeResult.ok };
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

    // If we previously wrote into overlapping memory address we simply
    // read from it.
    const written = this.#novelty.get(address);
    if (written) {
      return read(written, address);
    }

    // If we have not read nor written into overlapping memory address so
    // we'll read it from the local replica.
    const state = this.load(address);

    // Check if document exists when trying to read from nested path
    if (state.is === undefined && address.path.length > 0) {
      return { error: NotFound(attest(state), address) };
    }

    const loaded = attest(state);
    const { error, ok: invariant } = read(loaded, address);
    if (error) {
      // If the read failed because of path errors, this is still effectively a
      // read, so let's log it for validation
      if (
        error.name === "NotFoundError" || error.name === "TypeMismatchError"
      ) {
        this.#history.claim(loaded);
      }
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
        // During commit, NotFound and TypeMismatch errors should be treated as inconsistencies
        // because we're trying to apply changes to something that has changed state
        if (error.name === "NotFoundError") {
          return {
            error: StateInconsistency({
              address: changes.address,
              expected: "document to exist",
              actual: undefined,
            }),
          };
        } else if (error.name === "TypeMismatchError") {
          return {
            error: StateInconsistency({
              address: error.address,
              expected: "object",
              actual: error.actualType,
            }),
          };
        }
        return { error };
      }
      if (
        merged.value === loaded.is ||
        JSON.stringify(merged.value) === JSON.stringify(loaded.is)
      ) {
        // If merged value is the same as the loaded value, we simply claim the
        // loaded state.
        edit.claim(loaded);
      } else if (merged.value === undefined) {
        // If the merged value is `undefined`, retract the fact.
        // We cast here, since typescript doesn't realize that a non-assertion
        // would have matched on the initial if check.
        edit.retract(loaded as Assertion);
      } else {
        // If the merged value is neither `undefined` nor the existing value,
        // create an assertion referring to the loaded fact in a causal
        // reference.
        const factToRefer = loaded.cause ? normalizeFact(loaded) : loaded;
        const causeRef = refer(factToRefer);

        // Normalize the value to handle NaN and other non-JSON values
        // NaN gets serialized to null in JSON, so we normalize it here to ensure
        // consistent hashing between client and server
        const normalizedValue = JSON.parse(JSON.stringify(merged.value));

        edit.assert({
          ...loaded,
          is: normalizedValue,
          cause: causeRef,
        });
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

  /**
   * Claims a new read invariant while ensuring consistency with all the
   * previous invariants.
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
      if (Address.intersects(attestation.address, candidate.address)) {
        // Always read at the more specific (longer) path for consistency check
        const address =
          attestation.address.path.length > candidate.address.path.length
            ? attestation.address
            : candidate.address;

        const expected = read(candidate, address).ok?.value;
        const actual = read(attestation, address).ok?.value;

        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          return {
            error: StateInconsistency({
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
   * Claims a new write invariant by merging it into the document's root.
   *
   * OPTIMIZATION (CT-1123): Simplified to just call put() which now handles
   * all merging internally. The Changes class maintains a single merged root
   * attestation instead of multiple path-based entries.
   */
  claim(
    invariant: IAttestation,
  ): Result<
    IAttestation,
    IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
  > {
    const changes = this.edit(invariant.address);

    // Changes.put() handles all merging into the root
    changes.put(invariant);

    // Return the merged root state
    const root = changes.getRoot();
    return { ok: root ?? invariant };
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
   * Returns changes for the fact at the provided address.
   */
  select(address: IMemoryAddress) {
    return this.#model.get(`${address.id}/${address.type}`);
  }
}

/**
 * Changes tracks all writes to a single document as a merged root attestation.
 *
 * OPTIMIZATION (CT-1123): Instead of storing individual writes at different paths
 * and replaying them on read/commit (O(N²)), we merge all writes immediately into
 * a single root attestation. This makes each write O(1) instead of O(N).
 */
class Changes {
  #root: IAttestation | undefined; // Single merged state at root path
  #writtenPaths: Set<string> = new Set(); // Track which paths were explicitly written
  address: IMemoryAddress;

  constructor(address: Omit<IMemoryAddress, "path">) {
    this.address = { ...address, path: [] };
  }

  /**
   * Gets the current merged root attestation, or undefined if no writes yet.
   */
  getRoot(): IAttestation | undefined {
    return this.#root;
  }

  /**
   * Sets the merged root attestation after applying a write.
   * The attestation's address is normalized to root path [].
   */
  setRoot(attestation: IAttestation, writtenPath: readonly string[]): void {
    this.#root = {
      ...attestation,
      address: { ...attestation.address, path: [] },
    };
    // Track the path that was written to
    this.#writtenPaths.add(JSON.stringify(writtenPath));
  }

  /**
   * Gets attestation covering the requested path by reading from merged root.
   * Only returns if:
   * 1. We have a merged root
   * 2. There's a write at or above the requested path (parent path covers children)
   *
   * This preserves the original behavior where reads only short-circuit if
   * there's an overlapping write, ensuring history capture works correctly.
   */
  get(at: IMemoryAddress["path"]): IAttestation | undefined {
    if (!this.#root) return undefined;

    // Check if any written path is a prefix of (or equal to) the requested path
    // This matches the original behavior where parent writes cover child reads
    for (const pathStr of this.#writtenPaths) {
      const writtenPath = JSON.parse(pathStr) as string[];
      // Check if writtenPath is a prefix of 'at'
      if (
        writtenPath.length <= at.length &&
        writtenPath.every((p, i) => p === at[i])
      ) {
        return this.#root;
      }
    }

    return undefined;
  }

  // Legacy methods for compatibility during transition - kept for Novelty.claim()
  put(invariant: IAttestation) {
    const path = invariant.address.path;
    // Merge into root instead of storing separately
    if (!this.#root) {
      this.setRoot(invariant, path);
    } else {
      // Apply write to existing root
      const { ok } = write(this.#root, invariant.address, invariant.value);
      if (ok) {
        this.setRoot(ok, path);
      } else {
        // Fallback: just set as root (shouldn't happen in normal flow)
        this.setRoot(invariant, path);
      }
    }
  }

  delete(_invariant: IAttestation) {
    // With single root, delete is a no-op - the root contains everything
    // If caller wants to delete a path, they should write undefined to it
  }

  /**
   * Returns the merged root state. No rebase needed since we merge on write.
   * This method is kept for compatibility but just returns the root.
   */
  rebase(
    source: IAttestation,
  ): Result<
    IAttestation,
    IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
  > {
    if (!this.#root) {
      return { ok: source };
    }

    // The root already contains all merged writes, but we need to apply
    // the root's value onto the source (in case source was loaded fresh)
    const { error, ok } = write(
      source,
      this.#root.address,
      this.#root.value,
    );

    if (error) {
      return { error };
    }

    return { ok };
  }

  *[Symbol.iterator](): IterableIterator<IAttestation> {
    if (this.#root) {
      yield this.#root;
    }
  }
}
