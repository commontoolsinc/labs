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
  CodeMirrorReconciliationError,
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

  it("reports both sides of a reconciliation error", () => {
    const error = new CodeMirrorReconciliationError(
      "local",
      "canonical",
      { epoch: 1, version: 2 },
      { epoch: 2, version: 0 },
    );

    expect(error.name).toBe("CodeMirrorReconciliationError");
    expect(error.message).toContain("local edits pending");
    expect(error.localValue).toBe("local");
    expect(error.canonicalValue).toBe("canonical");
    expect(error.localCursor).toEqual({ epoch: 1, version: 2 });
    expect(error.canonicalCursor).toEqual({ epoch: 2, version: 0 });
  });

  it("rejects malformed and incompatible operation snapshots", () => {
    const snapshot = activeSnapshot("abc", {
      ...acceptedResolution("abc", 1, ""),
      operations: [],
    });
    snapshot.cursor = { epoch: 1, version: 1 };

    expect(() =>
      codeMirrorIntegratedUpdates(
        { ...snapshot, active: false, cursor: null },
        { epoch: 1, version: 0 },
      )
    ).toThrow("inactive operation field");
    expect(() =>
      codeMirrorIntegratedUpdates(
        { ...snapshot, codec: "other@1" },
        { epoch: 1, version: 0 },
      )
    ).toThrow("expected codemirror-changeset@1");
    expect(() =>
      codeMirrorIntegratedUpdates(snapshot, { epoch: 2, version: 0 })
    ).toThrow("epoch changed");
    expect(() =>
      codeMirrorIntegratedUpdates(snapshot, { epoch: 1, version: 2 })
    ).toThrow("older version 1");

    const operation = {
      opId: "op:bad",
      cursor: { epoch: 1, version: 1 },
      submissionId: "bad:1",
      payload: null,
    };
    expect(() =>
      codeMirrorIntegratedUpdates(
        { ...snapshot, operations: [operation] },
        { epoch: 1, version: 0 },
      )
    ).toThrow("requires an updates array");
    expect(() =>
      codeMirrorIntegratedUpdates(
        {
          ...snapshot,
          operations: [{
            ...operation,
            payload: { updates: [{ changes: [] }] },
          }],
        },
        { epoch: 1, version: 0 },
      )
    ).toThrow("requires a clientId");
    expect(() =>
      codeMirrorIntegratedUpdates(
        {
          ...snapshot,
          cursor: { epoch: 1, version: 2 },
          operations: [{
            ...operation,
            cursor: { epoch: 1, version: 2 },
            payload: { updates: [] },
          }],
        },
        { epoch: 1, version: 0 },
      )
    ).toThrow("gap before version 2");
  });

  it("rejects startup when the codec or snapshot cannot be installed", async () => {
    const missingCodec = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      codecs: [],
    });
    await expect(missingCodec.controller.start()).rejects.toThrow(
      "does not advertise",
    );

    const nonString = controllerHarness({
      initial: { ...inactiveSnapshot("abc"), materialized: 42 },
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
    });
    await expect(nonString.controller.start()).rejects.toThrow(
      "requires a string field",
    );

    const wrongCodec = controllerHarness({
      initial: {
        ...activeSnapshot("abc", acceptedResolution("abc", 1, "")),
        codec: "other@1",
      },
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
    });
    await expect(wrongCodec.controller.start()).rejects.toThrow(
      "cannot open operation codec",
    );
  });

  it("cancels a subscription that resolves after disposal", async () => {
    const subscribed = Promise.withResolvers<void>();
    const subscription = Promise.withResolvers<() => void>();
    let cancellations = 0;
    const { controller } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: () => subscribed.resolve(),
      subscription: subscription.promise,
    });

    const starting = controller.start();
    await subscribed.promise;
    controller.dispose();
    controller.dispose();
    subscription.resolve(() => cancellations++);
    await starting;

    expect(cancellations).toBe(1);
    await controller.localDocChanged();
    await controller.stop();
  });

  it("updates an inactive baseline and fails on divergent pending edits", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    let cancellations = 0;
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
      cancel: () => cancellations++,
    });

    await controller.start();
    subscriber?.(inactiveSnapshot("canonical"));
    expect(view.state.doc.toString()).toBe("canonical");

    view.dispatch({ changes: { from: 0, insert: "local:" } });
    subscriber?.(inactiveSnapshot("other"));
    expect(errors[0]).toBeInstanceOf(CodeMirrorReconciliationError);
    expect(cancellations).toBe(1);
    subscriber?.(inactiveSnapshot("ignored"));
    expect(errors).toHaveLength(1);
  });

  it("reconciles active-to-inactive and epoch changes with pending edits", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const accepted = acceptedResolution("abc", 1, "X");
    const initial = activeSnapshot("aXbc", accepted);
    const first = controllerHarness({
      initial,
      followup: initial,
      apply: () => accepted,
      subscribe: (callback) => subscriber = callback,
    });
    await first.controller.start();
    first.view.dispatch({ changes: { from: 0, insert: "local:" } });
    subscriber?.(inactiveSnapshot("canonical"));
    expect(first.errors[0]).toBeInstanceOf(CodeMirrorReconciliationError);

    const second = controllerHarness({
      initial,
      followup: initial,
      apply: () => accepted,
      subscribe: (callback) => subscriber = callback,
    });
    await second.controller.start();
    second.view.dispatch({ changes: { from: 0, insert: "local:" } });
    subscriber?.({
      ...initial,
      cursor: { epoch: 2, version: 0 },
      materialized: "canonical",
      operations: [],
    });
    expect(second.errors[0]).toBeInstanceOf(CodeMirrorReconciliationError);
  });

  it("adopts the first active cursor delivered to an inactive controller", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const { controller, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
    });
    await controller.start();
    subscriber?.({
      ...inactiveSnapshot("abc"),
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 0 },
    });

    expect(errors).toEqual([]);
    expect(controller.active).toBe(true);
  });

  it("reinstalls reset and epoch snapshots only without pending edits", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const initialResolution = acceptedResolution("abc", 1, "X");
    const initial = activeSnapshot("aXbc", initialResolution);
    const { controller, view, errors } = controllerHarness({
      initial,
      followup: initial,
      apply: () => initialResolution,
      subscribe: (callback) => subscriber = callback,
    });

    await controller.start();
    subscriber?.({
      ...initial,
      reset: true,
      cursor: { epoch: 1, version: 2 },
      materialized: "reset",
    });
    expect(view.state.doc.toString()).toBe("reset");

    subscriber?.({
      ...initial,
      cursor: { epoch: 2, version: 0 },
      materialized: "epoch-two",
      operations: [],
    });
    expect(view.state.doc.toString()).toBe("epoch-two");

    view.dispatch({ changes: { from: 0, insert: "local:" } });
    subscriber?.({
      ...initial,
      reset: true,
      cursor: { epoch: 2, version: 1 },
      materialized: "canonical",
    });
    expect(errors[0]).toBeInstanceOf(CodeMirrorReconciliationError);
  });

  it("receives integrated updates and detects a materialization mismatch", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const initial = {
      ...inactiveSnapshot("abc"),
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 0 },
    };
    const { controller, view, errors } = controllerHarness({
      initial,
      followup: initial,
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
    });

    await controller.start();
    const accepted = acceptedResolution("abc", 1, "X");
    subscriber?.({
      ...activeSnapshot("aXbc", accepted),
      operations: accepted.operations,
    });
    expect(view.state.doc.toString()).toBe("aXbc");
    subscriber?.({
      ...activeSnapshot("wrong", accepted),
      operations: [],
    });
    expect(errors[0]?.message).toContain("do not reproduce");
  });

  it("fails closed when an apply rejects and refuses to drop pending edits", async () => {
    let cancellations = 0;
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => Promise.reject("apply failed"),
      cancel: () => cancellations++,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors[0]?.message).toBe("apply failed");
    expect(cancellations).toBe(1);
    await expect(controller.stop()).rejects.toThrow("local edits pending");
  });

  it("fails closed when an apply response advertises another codec", async () => {
    let cancellations = 0;
    const resolution = {
      ...acceptedResolution("abc", 1, "X"),
      codec: "other@1",
    };
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => resolution,
      cancel: () => cancellations++,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors[0]?.message).toContain("received operation codec other@1");
    expect(cancellations).toBe(1);
  });

  it("releases an active controller whose field has no cursor", async () => {
    let releases = 0;
    let cancellations = 0;
    const { controller } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      cancel: () => cancellations++,
      release: () => {
        releases++;
      },
    });

    await controller.start();
    await controller.release();

    expect(releases).toBe(0);
    expect(cancellations).toBe(1);
    expect(controller.active).toBe(false);
  });

  it("releases an active field and accepts its inactive notification", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    let releases = 0;
    let cancellations = 0;
    const accepted = acceptedResolution("abc", 1, "X");
    const initial = activeSnapshot("aXbc", accepted);
    const { controller } = controllerHarness({
      initial,
      followup: initial,
      apply: () => accepted,
      subscribe: (callback) => subscriber = callback,
      cancel: () => cancellations++,
      release: () => {
        releases++;
        subscriber?.(inactiveSnapshot("aXbc"));
      },
    });

    await controller.start();
    await controller.release();

    expect(releases).toBe(1);
    expect(cancellations).toBe(1);
    expect(controller.active).toBe(false);
    await expect(controller.release()).rejects.toThrow("is not active");
  });

  it("flushes an edit that arrives while the preceding apply is in flight", async () => {
    const first = Promise.withResolvers<ApplyOpResolution>();
    const second = Promise.withResolvers<ApplyOpResolution>();
    const firstCalled = Promise.withResolvers<void>();
    const secondCalled = Promise.withResolvers<void>();
    let applyCount = 0;
    const firstResolution = acceptedResolution("abc", 1, "X");
    const secondResolution = acceptedResolutionAt(
      "aXbc",
      1,
      2,
      "Y",
      "alice:2",
    );
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followups: [
        activeSnapshot("aXbc", firstResolution),
        activeSnapshot("aXYbc", secondResolution),
      ],
      apply: () => {
        applyCount++;
        if (applyCount === 1) {
          firstCalled.resolve();
          return first.promise;
        }
        secondCalled.resolve();
        return second.promise;
      },
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    const sending = controller.localDocChanged();
    await firstCalled.promise;
    view.dispatch({ changes: { from: 2, insert: "Y" } });
    const stopping = controller.stop();
    first.resolve(firstResolution);
    await secondCalled.promise;
    second.resolve(secondResolution);
    await Promise.all([sending, stopping]);

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("aXYbc");
    expect(sendableUpdates(view.state)).toHaveLength(0);
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

function acceptedResolutionAt(
  document: string,
  fromVersion: number,
  from: number,
  insert: string,
  submissionId: string,
): ApplyOpResolution {
  const resolution = acceptedResolution(document, from, insert);
  return {
    ...resolution,
    submissionId,
    from: { epoch: 1, version: fromVersion },
    to: { epoch: 1, version: fromVersion + 1 },
    operations: resolution.operations.map((operation) => ({
      ...operation,
      opId: `op:${submissionId}`,
      cursor: { epoch: 1, version: fromVersion + 1 },
      submissionId,
    })),
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
  followup?: OperationFieldSnapshot;
  followups?: OperationFieldSnapshot[];
  apply: () => ApplyOpResolution | Promise<ApplyOpResolution>;
  codecs?: string[];
  subscribe?: (callback: (snapshot: OperationFieldSnapshot) => void) => void;
  subscription?: Promise<() => void>;
  cancel?: () => void;
  release?: () => void | Promise<void>;
}) {
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: typeof options.initial.materialized === "string"
      ? options.initial.materialized
      : "",
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
  const followups = options.followups ?? [options.followup ?? options.initial];
  const runtime = {
    operationCodecs: () =>
      Promise.resolve(options.codecs ?? ["codemirror-changeset@1"]),
    queryOperationField: () =>
      Promise.resolve(
        queryCount++ === 0
          ? options.initial
          : followups[Math.min(queryCount - 2, followups.length - 1)],
      ),
    subscribeOperationField: (
      _cell: CellHandle<string>,
      callback: (snapshot: OperationFieldSnapshot) => void,
    ) => {
      options.subscribe?.(callback);
      return options.subscription ??
        Promise.resolve(() => options.cancel?.());
    },
    applyOperation: () => Promise.resolve(options.apply()),
    releaseOperationField: () => Promise.resolve(options.release?.()),
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
