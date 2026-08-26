import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { receiveUpdates, sendableUpdates } from "@codemirror/collab";
import {
  ChangeSet,
  Compartment,
  EditorState,
  Text,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type {
  ApplyOpResolution,
  CellHandle,
  OperationFieldSnapshot,
  RuntimeClient,
} from "@commonfabric/runtime-client";
import {
  codeMirrorCollaboration,
  CodeMirrorCollaborationController,
  codeMirrorIntegratedUpdates,
  codeMirrorSubmission,
} from "./codemirror-collaboration.ts";

const path = [] as unknown as OperationFieldSnapshot["path"];

describe("CodeMirror operation collaboration", () => {
  it("serializes local edits and rebases them over canonical operations", () => {
    const initial = EditorState.create({
      doc: "abc",
      extensions: [codeMirrorCollaboration(0, "alice")],
    });
    const local = initial.update({
      changes: { from: 1, insert: "X" },
    }).state;

    expect(codeMirrorSubmission(local)).toEqual({
      baseVersion: 0,
      payload: {
        updates: [{
          clientId: "alice",
          changes: ChangeSet.of({ from: 1, insert: "X" }, 3).toJSON(),
        }],
      },
    });

    const bob = ChangeSet.of({ from: 1, insert: "Y" }, 3);
    const remote: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 1 },
      baselineHash: "baseline",
      materialized: "aYbc",
      operations: [{
        opId: "op:bob-1",
        cursor: { epoch: 1, version: 1 },
        submissionId: "bob-1",
        payload: {
          updates: [{ clientId: "bob", changes: bob.toJSON() }],
        },
      }],
    };
    const rebased = receiveState(
      local,
      remote,
      { epoch: 1, version: 0 },
    );
    const pending = codeMirrorSubmission(rebased);
    expect(pending?.baseVersion).toBe(1);
    expect(pending?.payload.updates).toHaveLength(1);

    const accepted = ChangeSet.fromJSON(
      pending!.payload.updates[0].changes as Parameters<
        typeof ChangeSet.fromJSON
      >[0],
    );
    const materialized = accepted.apply(Text.of(["aYbc"])).toString();
    const confirmed: OperationFieldSnapshot = {
      ...remote,
      cursor: { epoch: 1, version: 2 },
      materialized,
      operations: [{
        opId: "op:alice-1",
        cursor: { epoch: 1, version: 2 },
        submissionId: "alice-1",
        payload: pending!.payload,
      }],
    };
    const final = receiveState(
      rebased,
      confirmed,
      { epoch: 1, version: 1 },
    );
    expect(final.doc.toString()).toBe(materialized);
    expect(sendableUpdates(final)).toHaveLength(0);
  });

  it("rejects a non-contiguous operation suffix", () => {
    const snapshot: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 2 },
      baselineHash: "baseline",
      materialized: "abc",
      operations: [],
    };
    expect(() =>
      codeMirrorIntegratedUpdates(snapshot, { epoch: 1, version: 0 })
    ).toThrow("history ends at 0");
  });

  it("requires canonical reinstallation for a retention reset", () => {
    const snapshot: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 10 },
      retainedFrom: { epoch: 1, version: 8 },
      reset: true,
      baselineHash: "baseline",
      materialized: "canonical",
      operations: [],
    };

    expect(() =>
      codeMirrorIntegratedUpdates(snapshot, { epoch: 1, version: 7 })
    ).toThrow("requires a reset");
  });

  it("ignores an already integrated operation prefix", () => {
    const snapshot: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 1 },
      baselineHash: "baseline",
      materialized: "abc",
      operations: [{
        opId: "op:already-integrated",
        cursor: { epoch: 1, version: 1 },
        submissionId: "alice-1",
        payload: { updates: [] },
      }],
    };

    expect(
      codeMirrorIntegratedUpdates(snapshot, { epoch: 1, version: 1 }),
    ).toEqual([]);
  });

  it("ignores the unchanged inactive baseline while activation is in flight", async () => {
    const initial = inactiveSnapshot("abc");
    const accepted = acceptedResolution("abc", 1, "X");
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const { controller, view, errors } = controllerHarness({
      initial,
      followup: activeSnapshot("aXbc", accepted),
      subscribe(callback) {
        subscriber = callback;
      },
      apply() {
        subscriber?.(initial);
        return accepted;
      },
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("aXbc");
    expect(sendableUpdates(view.state)).toHaveLength(0);
  });

  it("confirms the apply response before a released follow-up snapshot", async () => {
    const accepted = acceptedResolution("abc", 1, "X");
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("aXbc"),
      apply: () => accepted,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("aXbc");
    expect(sendableUpdates(view.state)).toHaveLength(0);
  });

  it("flushes pending edits before stopping collaboration", async () => {
    const accepted = acceptedResolution("abc", 1, "X");
    const applied = Promise.withResolvers<ApplyOpResolution>();
    let cancellations = 0;
    const { controller, view } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: activeSnapshot("aXbc", accepted),
      apply: () => applied.promise,
      cancel: () => cancellations++,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    const sending = controller.localDocChanged();
    await Promise.resolve();
    const stopped = controller.stop();
    let settled = false;
    void stopped.finally(() => settled = true);
    await Promise.resolve();
    expect(settled).toBe(false);

    applied.resolve(accepted);
    await Promise.all([sending, stopped]);
    expect(sendableUpdates(view.state)).toHaveLength(0);
    expect(cancellations).toBe(1);
  });

  it("cancels superseded setup before collaboration state is installed", async () => {
    let subscriptions = 0;
    const { controller } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: () => subscriptions++,
    });

    const starting = controller.start();
    await controller.stop();
    await starting;

    expect(controller.active).toBe(false);
    expect(subscriptions).toBe(0);
  });

  it("unsubscribes when a remote snapshot fails", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    let cancellations = 0;
    const { controller, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
      cancel: () => cancellations++,
    });

    await controller.start();
    subscriber?.({ ...inactiveSnapshot("abc"), materialized: 42 });

    expect(errors).toHaveLength(1);
    expect(cancellations).toBe(1);
  });
});

function inactiveSnapshot(materialized: string): OperationFieldSnapshot {
  return {
    branch: "",
    id: "of:editor",
    scopeKey: "space",
    path,
    active: false,
    codec: null,
    cursor: null,
    baselineHash: `baseline:${materialized}`,
    materialized,
    operations: [],
  };
}

function acceptedResolution(
  document: string,
  from: number,
  insert: string,
): ApplyOpResolution {
  const payload = {
    updates: [{
      clientId: "alice",
      changes: ChangeSet.of({ from, insert }, document.length).toJSON(),
    }],
  };
  return {
    operationIndex: 0,
    address: {
      branch: "",
      id: "of:editor",
      scopeKey: "space",
      path,
    },
    codec: "codemirror-changeset@1",
    submissionId: "alice:1",
    from: { epoch: 1, version: 0 },
    to: { epoch: 1, version: 1 },
    operations: [{
      opId: "op:alice-1",
      cursor: { epoch: 1, version: 1 },
      submissionId: "alice:1",
      payload,
    }],
    duplicate: false,
  };
}

function activeSnapshot(
  materialized: string,
  resolution: ApplyOpResolution,
): OperationFieldSnapshot {
  return {
    ...resolution.address,
    active: true,
    codec: resolution.codec,
    cursor: resolution.to,
    baselineHash: "baseline:abc",
    materialized,
    operations: [],
  };
}

function controllerHarness(options: {
  initial: OperationFieldSnapshot;
  followup: OperationFieldSnapshot;
  apply: () => ApplyOpResolution | Promise<ApplyOpResolution>;
  subscribe?: (callback: (snapshot: OperationFieldSnapshot) => void) => void;
  cancel?: () => void;
}) {
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: options.initial.materialized as string,
    extensions: [compartment.of([])],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(...specs: readonly TransactionSpec[]) {
      state = state.update(...specs).state;
    },
  } as unknown as EditorView;
  let queryCount = 0;
  const runtime = {
    operationCodecs: () => Promise.resolve(["codemirror-changeset@1"]),
    queryOperationField: () =>
      Promise.resolve(queryCount++ === 0 ? options.initial : options.followup),
    subscribeOperationField: (
      _cell: CellHandle<string>,
      callback: (snapshot: OperationFieldSnapshot) => void,
    ) => {
      options.subscribe?.(callback);
      return Promise.resolve(() => options.cancel?.());
    },
    applyOperation: () => Promise.resolve(options.apply()),
  } as unknown as RuntimeClient;
  const errors: Error[] = [];
  const controller = new CodeMirrorCollaborationController({
    runtime,
    cell: {} as CellHandle<string>,
    view,
    compartment,
    clientId: "alice",
    onError: (error) => errors.push(error),
  });
  return { controller, view, errors };
}

function receiveState(
  state: EditorState,
  snapshot: OperationFieldSnapshot,
  cursor: { epoch: number; version: number },
): EditorState {
  const updates = codeMirrorIntegratedUpdates(snapshot, cursor);
  return receiveUpdates(state, updates).state;
}
