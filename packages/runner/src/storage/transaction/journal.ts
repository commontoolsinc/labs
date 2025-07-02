import type {
  Activity,
  IAttestation,
  IMemoryAddress,
  InactiveTransactionError,
  IStorageManager,
  IStorageTransactionAborted,
  IStorageTransactionComplete,
  IStorageTransactionInconsistent,
  ITransactionJournal,
  ITransactionReader,
  ITransactionWriter,
  JournalArchive,
  JSONValue,
  MemorySpace,
  ReadError,
  Result,
  WriteError,
} from "../interface.ts";
import * as Chronicle from "./chronicle.ts";

export interface UnknownState {
  branches: Map<MemorySpace, Chronicle.Chronicle>;
  activity: Activity[];
}

export interface OpenState extends UnknownState {
  status: "open";
  storage: IStorageManager;
  readers: Map<MemorySpace, TransactionReader>;
  writers: Map<MemorySpace, TransactionWriter>;
}

export interface ClosedState extends UnknownState {
  status: "closed";
  reason: Result<
    JournalArchive,
    IStorageTransactionAborted | IStorageTransactionInconsistent
  >;
}

export type State = OpenState | ClosedState;
export type IJournal = { state: State };

export type { Journal };
/**
 * Class for maintaining lifecycle of the storage transaction. It's job is to
 * have central place to manage state of the transaction and prevent readers /
 * writers from making to mutate transaction after it's being commited.
 */
class Journal implements IJournal, ITransactionJournal {
  #state: State;
  constructor(state: State) {
    this.#state = state;
  }

  get state() {
    return this.#state;
  }

  set state(newState: State) {
    this.#state = newState;
  }

  get status() {
    return this.#state.status;
  }

  activity() {
    return this.#state.activity;
  }

  *novelty(space: MemorySpace) {
    const branch = this.#state.branches.get(space);
    if (branch) {
      yield* branch.novelty();
    }
  }

  *history(space: MemorySpace) {
    const branch = this.#state.branches.get(space);
    if (branch) {
      yield* branch.history();
    }
  }

  reader(space: MemorySpace) {
    return reader(this, space);
  }
  writer(space: MemorySpace) {
    return writer(this, space);
  }
  close() {
    return close(this);
  }
  abort(reason: unknown) {
    return abort(this, reason);
  }
}

export const read = (
  journal: IJournal,
  space: MemorySpace,
  address: IMemoryAddress,
): Result<IAttestation, ReadError> => {
  const { ok: branch, error } = checkout(journal, space);
  if (error) {
    return { error };
  } else {
    const result = branch.read(address);
    if (result.error) {
      return { error: result.error.from(space) };
    } else {
      return result;
    }
  }
};

export const write = (
  journal: IJournal,
  space: MemorySpace,
  address: IMemoryAddress,
  value?: JSONValue,
): Result<IAttestation, WriteError> => {
  const { ok: branch, error } = checkout(journal, space);
  if (error) {
    return { error };
  } else {
    const result = branch.write(address, value);
    if (result.error) {
      return { error: result.error.from(space) };
    } else {
      return result;
    }
  }
};

const checkout = (
  journal: IJournal,
  space: MemorySpace,
): Result<Chronicle.Chronicle, InactiveTransactionError> => {
  const { ok: open, error } = edit(journal);
  if (error) {
    return { error };
  } else {
    const branch = open.branches.get(space);
    if (branch) {
      return { ok: branch };
    } else {
      const { replica } = open.storage.open(space);
      const branch = Chronicle.open(replica);
      open.branches.set(space, branch);
      return { ok: branch };
    }
  }
};

const edit = (
  { state }: IJournal,
): Result<OpenState, InactiveTransactionError> => {
  if (state.status === "closed") {
    if (state.reason.error) {
      return state.reason;
    } else {
      return {
        error: new TransactionCompleteError(`Journal is closed`),
      };
    }
  } else {
    return { ok: state };
  }
};

export const reader = (
  journal: IJournal,
  space: MemorySpace,
): Result<TransactionReader, InactiveTransactionError> => {
  const { ok: open, error } = edit(journal);
  if (error) {
    return { error };
  } else {
    // Otherwise we lookup a a reader for the requested `space`, if we one
    // already exists return it otherwise create one and return it.
    const reader = open.readers.get(space);
    if (reader) {
      return { ok: reader };
    } else {
      const reader = new TransactionReader(journal, space);

      // Store reader so that subsequent attempts calls of this method.
      open.readers.set(space, reader);
      return { ok: reader };
    }
  }
};

export const writer = (
  journal: IJournal,
  space: MemorySpace,
): Result<TransactionWriter, InactiveTransactionError> => {
  // Obtait edit session for this journal, if it fails journal is
  // no longer open, in which case we propagate error.
  const { ok: open, error } = edit(journal);
  if (error) {
    return { error };
  } else {
    // If we obtained open journal lookup a writer for the given `space`, if we
    // have one return it otherwise create a new one and return it instead.
    const writer = open.writers.get(space);
    if (writer) {
      return { ok: writer };
    } else {
      const writer = new TransactionWriter(journal, space);

      // Store writer so that subsequent attempts calls of this method.
      open.writers.set(space, writer);
      return { ok: writer };
    }
  }
};

export const abort = (journal: IJournal, reason: unknown) => {
  const { ok: open, error } = edit(journal);
  if (error) {
    return { error };
  } else {
    journal.state = {
      branches: open.branches,
      activity: open.activity,
      status: "closed",
      reason: { error: new TransactionAborted(reason) },
    };

    return { ok: journal };
  }
};

export const close = (journal: IJournal) => {
  const { ok: open, error } = edit(journal);
  if (error) {
    return { error };
  } else {
    const archive: JournalArchive = new Map();
    for (const [space, chronicle] of open.branches) {
      const { error, ok } = chronicle.commit();
      if (error) {
        journal.state = {
          branches: open.branches,
          activity: open.activity,
          status: "closed",
          reason: { error },
        };
        return { error };
      } else {
        archive.set(space, ok);
      }
    }

    journal.state = {
      branches: open.branches,
      activity: open.activity,
      status: "closed",
      reason: { ok: archive },
    };

    return { ok: archive };
  }
};

export const open = (storage: IStorageManager) =>
  new Journal({
    status: "open",
    storage,
    activity: [],
    branches: new Map(),
    readers: new Map(),
    writers: new Map(),
  });

/**
 * Transaction reader implementation for reading from a specific memory space.
 * Maintains its own set of Read invariants and can consult Write changes.
 */
export class TransactionReader implements ITransactionReader {
  #journal: IJournal;
  #space: MemorySpace;

  constructor(
    journal: IJournal,
    space: MemorySpace,
  ) {
    this.#journal = journal;
    this.#space = space;
  }

  read(address: IMemoryAddress) {
    return read(this.#journal, this.#space, address);
  }
}

/**
 * Transaction writer implementation that wraps a TransactionReader
 * and maintains its own set of Write changes.
 */
export class TransactionWriter implements ITransactionWriter {
  #journal: IJournal;
  #space: MemorySpace;

  constructor(
    journal: IJournal,
    space: MemorySpace,
  ) {
    this.#journal = journal;
    this.#space = space;
  }

  read(address: IMemoryAddress) {
    return read(this.#journal, this.#space, address);
  }

  /**
   * Attempts to write a value at a given memory address and captures relevant
   */
  write(
    address: IMemoryAddress,
    value?: JSONValue,
  ) {
    return write(this.#journal, this.#space, address, value);
  }
}

export class TransactionCompleteError extends RangeError
  implements IStorageTransactionComplete {
  override name = "StorageTransactionCompleteError" as const;
}

export class TransactionAborted extends RangeError
  implements IStorageTransactionAborted {
  override name = "StorageTransactionAborted" as const;
  reason: unknown;

  constructor(reason?: unknown) {
    super("Transaction was aborted");
    this.reason = reason;
  }
}
