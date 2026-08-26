import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import {
  ChangeSet,
  type Compartment,
  type EditorState,
  type Extension,
  Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  type CellHandle,
  CODEMIRROR_CHANGESET_CODEC,
  type JSONValue,
  type OpCursor,
  type OperationFieldSnapshot,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

export type CodeMirrorOperationPayload = {
  updates: Array<{
    clientId: string;
    changes: JSONValue;
  }>;
};

export type CodeMirrorSubmission = {
  baseVersion: number;
  payload: CodeMirrorOperationPayload;
};

/** Preserves both values when a new epoch cannot absorb unconfirmed edits. */
export class CodeMirrorReconciliationError extends Error {
  override readonly name = "CodeMirrorReconciliationError";

  constructor(
    readonly localValue: string,
    readonly canonicalValue: string,
    readonly localCursor: OpCursor | null,
    readonly canonicalCursor: OpCursor | null,
  ) {
    super("CodeMirror operation state changed with local edits pending");
  }
}

/** Creates CodeMirror's local OT state at one canonical Memory version. */
export function codeMirrorCollaboration(
  startVersion: number,
  clientId: string,
): Extension {
  return collab({ startVersion, clientID: clientId });
}

/** Serializes every local CodeMirror update not yet confirmed by Memory. */
export function codeMirrorSubmission(
  state: EditorState,
): CodeMirrorSubmission | undefined {
  const pending = sendableUpdates(state);
  if (pending.length === 0) return undefined;
  return {
    baseVersion: getSyncedVersion(state),
    payload: {
      updates: pending.map((update) => ({
        clientId: update.clientID,
        changes: update.changes.toJSON() as JSONValue,
      })),
    },
  };
}

const decodePayload = (payload: unknown): Update[] => {
  if (
    payload === null || typeof payload !== "object" ||
    !Array.isArray((payload as { updates?: unknown }).updates)
  ) {
    throw new Error("CodeMirror operation payload requires an updates array");
  }
  return (payload as { updates: unknown[] }).updates.map((value) => {
    if (
      value === null || typeof value !== "object" ||
      typeof (value as { clientId?: unknown }).clientId !== "string"
    ) {
      throw new Error("CodeMirror operation update requires a clientId");
    }
    return {
      clientID: (value as { clientId: string }).clientId,
      changes: ChangeSet.fromJSON(
        (value as { changes: Parameters<typeof ChangeSet.fromJSON>[0] })
          .changes,
      ),
    };
  });
};

/**
 * Decodes the contiguous suffix needed to move CodeMirror from `current` to
 * the snapshot cursor. Memory snapshots may repeat older operations, so that
 * prefix is deliberately ignored.
 */
export function codeMirrorIntegratedUpdates(
  snapshot: OperationFieldSnapshot,
  current: OpCursor,
): Update[] {
  if (!snapshot.active || snapshot.cursor === null) {
    throw new Error("CodeMirror received an inactive operation field");
  }
  if (snapshot.codec !== CODEMIRROR_CHANGESET_CODEC) {
    throw new Error(
      `CodeMirror received operation codec ${snapshot.codec}, expected ` +
        CODEMIRROR_CHANGESET_CODEC,
    );
  }
  if (snapshot.reset === true) {
    throw new Error("CodeMirror operation history requires a reset");
  }
  if (snapshot.cursor.epoch !== current.epoch) {
    throw new Error(
      `CodeMirror operation epoch changed from ${current.epoch} to ` +
        snapshot.cursor.epoch,
    );
  }
  if (snapshot.cursor.version < current.version) {
    throw new Error(
      `CodeMirror is at operation version ${current.version}, but received ` +
        `older version ${snapshot.cursor.version}`,
    );
  }

  const operations = snapshot.operations.filter((operation) =>
    operation.cursor.epoch === current.epoch &&
    operation.cursor.version > current.version
  );
  let expectedVersion = current.version + 1;
  const updates: Update[] = [];
  for (const operation of operations) {
    if (operation.cursor.version !== expectedVersion) {
      throw new Error(
        `CodeMirror operation history has a gap before version ` +
          operation.cursor.version,
      );
    }
    updates.push(...decodePayload(operation.payload));
    expectedVersion++;
  }
  if (expectedVersion - 1 !== snapshot.cursor.version) {
    throw new Error(
      `CodeMirror operation history ends at ${expectedVersion - 1}, but ` +
        `the field cursor is ${snapshot.cursor.version}`,
    );
  }
  return updates;
}

type ControllerOptions = {
  runtime: RuntimeClient;
  cell: CellHandle<string>;
  view: EditorView;
  compartment: Compartment;
  clientId?: string;
  onError: (error: Error) => void;
};

/** Drives CodeMirror's OT state against the runtime's generic operation API. */
export class CodeMirrorCollaborationController {
  readonly #runtime: RuntimeClient;
  readonly #cell: CellHandle<string>;
  readonly #view: EditorView;
  readonly #compartment: Compartment;
  readonly #clientId: string;
  readonly #onError: (error: Error) => void;
  #cursor: OpCursor | null = null;
  #baselineHash = "";
  #unsubscribe: (() => void) | undefined;
  #ready = false;
  #sending = false;
  #releasing = false;
  #failed = false;
  #disposed = false;

  constructor(options: ControllerOptions) {
    this.#runtime = options.runtime;
    this.#cell = options.cell;
    this.#view = options.view;
    this.#compartment = options.compartment;
    this.#clientId = options.clientId ?? crypto.randomUUID();
    this.#onError = options.onError;
  }

  get active(): boolean {
    return this.#ready && !this.#failed && !this.#disposed;
  }

  async start(): Promise<void> {
    const codecs = await this.#runtime.operationCodecs(this.#cell);
    if (!codecs.includes(CODEMIRROR_CHANGESET_CODEC)) {
      throw new Error(
        `Memory server does not advertise ${CODEMIRROR_CHANGESET_CODEC}`,
      );
    }
    const snapshot = await this.#runtime.queryOperationField(this.#cell);
    if (this.#disposed) return;
    this.#install(snapshot);
    const unsubscribe = await this.#runtime.subscribeOperationField(
      this.#cell,
      (next) => this.#receive(next),
      snapshot.cursor ?? undefined,
    );
    if (this.#disposed) {
      unsubscribe();
      return;
    }
    this.#unsubscribe = unsubscribe;
  }

  localDocChanged(): void {
    if (!this.active || this.#failed) return;
    void this.#flush();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async release(): Promise<void> {
    if (!this.active) {
      throw new Error("CodeMirror collaboration is not active");
    }
    await this.#flush();
    if (sendableUpdates(this.#view.state).length !== 0) {
      throw new Error(
        "CodeMirror collaboration cannot be released with local edits pending",
      );
    }
    const cursor = this.#cursor;
    if (cursor !== null) {
      this.#releasing = true;
      try {
        await this.#runtime.releaseOperationField(
          this.#cell,
          CODEMIRROR_CHANGESET_CODEC,
          cursor,
        );
      } finally {
        this.#releasing = false;
      }
    }
    this.dispose();
  }

  #install(snapshot: OperationFieldSnapshot): void {
    if (typeof snapshot.materialized !== "string") {
      throw new Error("CodeMirror collaboration requires a string field");
    }
    if (
      snapshot.active && snapshot.codec !== CODEMIRROR_CHANGESET_CODEC
    ) {
      throw new Error(
        `CodeMirror cannot open operation codec ${snapshot.codec}`,
      );
    }
    const version = snapshot.cursor?.version ?? 0;
    this.#ready = false;
    // A document-changing transaction that installs the collab extension is
    // observed by CodeMirror as a local update before the new client ID facet
    // is available. Clear the old epoch and synchronize the document first,
    // then install a clean collaboration state at the canonical version.
    this.#view.dispatch({
      changes: {
        from: 0,
        to: this.#view.state.doc.length,
        insert: snapshot.materialized,
      },
      effects: this.#compartment.reconfigure([]),
      annotations: Transaction.remote.of(true),
    });
    this.#view.dispatch({
      effects: this.#compartment.reconfigure(
        codeMirrorCollaboration(version, this.#clientId),
      ),
      annotations: Transaction.remote.of(true),
    });
    this.#cursor = snapshot.cursor;
    this.#baselineHash = snapshot.baselineHash;
    this.#ready = true;
  }

  #receive(snapshot: OperationFieldSnapshot): void {
    if (!this.active || this.#failed) return;
    try {
      if (typeof snapshot.materialized !== "string") {
        throw new Error("CodeMirror collaboration requires a string field");
      }
      if (!snapshot.active || snapshot.cursor === null) {
        if (this.#cursor !== null) {
          if (this.#releasing) {
            this.#cursor = null;
            this.#baselineHash = snapshot.baselineHash;
            return;
          }
          if (sendableUpdates(this.#view.state).length !== 0) {
            throw new CodeMirrorReconciliationError(
              this.#view.state.doc.toString(),
              snapshot.materialized,
              this.#cursor,
              null,
            );
          }
          this.#install(snapshot);
          return;
        }
        if (sendableUpdates(this.#view.state).length === 0) {
          this.#baselineHash = snapshot.baselineHash;
          if (this.#view.state.doc.toString() !== snapshot.materialized) {
            this.#view.dispatch({
              changes: {
                from: 0,
                to: this.#view.state.doc.length,
                insert: snapshot.materialized,
              },
              annotations: Transaction.remote.of(true),
            });
          }
        } else if (this.#view.state.doc.toString() !== snapshot.materialized) {
          throw new CodeMirrorReconciliationError(
            this.#view.state.doc.toString(),
            snapshot.materialized,
            null,
            null,
          );
        }
        return;
      }

      if (snapshot.reset === true) {
        if (sendableUpdates(this.#view.state).length !== 0) {
          throw new CodeMirrorReconciliationError(
            this.#view.state.doc.toString(),
            snapshot.materialized,
            this.#cursor,
            snapshot.cursor,
          );
        }
        this.#install(snapshot);
        return;
      }

      if (this.#cursor === null) {
        this.#cursor = { epoch: snapshot.cursor.epoch, version: 0 };
      } else if (this.#cursor.epoch !== snapshot.cursor.epoch) {
        if (sendableUpdates(this.#view.state).length !== 0) {
          throw new CodeMirrorReconciliationError(
            this.#view.state.doc.toString(),
            snapshot.materialized,
            this.#cursor,
            snapshot.cursor,
          );
        }
        this.#install(snapshot);
        return;
      }

      const current = {
        epoch: this.#cursor.epoch,
        version: getSyncedVersion(this.#view.state),
      };
      const updates = codeMirrorIntegratedUpdates(snapshot, current);
      if (updates.length !== 0) {
        this.#view.dispatch(receiveUpdates(this.#view.state, updates));
      }
      this.#cursor = {
        epoch: snapshot.cursor.epoch,
        version: getSyncedVersion(this.#view.state),
      };
      this.#baselineHash = snapshot.baselineHash;
      if (
        sendableUpdates(this.#view.state).length === 0 &&
        this.#view.state.doc.toString() !== snapshot.materialized
      ) {
        throw new Error(
          "CodeMirror operations do not reproduce Memory's materialized value",
        );
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  async #flush(): Promise<void> {
    if (!this.active || this.#sending || this.#failed) return;
    const submission = codeMirrorSubmission(this.#view.state);
    if (submission === undefined) return;
    this.#sending = true;
    let accepted = false;
    try {
      const base = this.#cursor === null
        ? null
        : { epoch: this.#cursor.epoch, version: submission.baseVersion };
      await this.#runtime.applyOperation(this.#cell, {
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: crypto.randomUUID(),
        base,
        ...(base === null ? { baselineHash: this.#baselineHash } : {}),
        payload: submission.payload,
      });
      const snapshot = await this.#runtime.queryOperationField(
        this.#cell,
        this.#cursor ?? undefined,
      );
      this.#receive(snapshot);
      accepted = !this.#failed;
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#sending = false;
    }
    if (
      accepted && this.active &&
      codeMirrorSubmission(this.#view.state) !== undefined
    ) {
      queueMicrotask(() => void this.#flush());
    }
  }

  #fail(cause: unknown): void {
    if (this.#failed || this.#disposed) return;
    this.#failed = true;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.#onError(error);
  }
}
