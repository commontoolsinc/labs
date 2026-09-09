import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  Compartment,
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  CellHandle,
  type CellRef,
  CODEMIRROR_CHANGESET_CODEC,
  type OperationFieldSnapshot,
} from "@commonfabric/runtime-client";
import { CFCodeEditor } from "./cf-code-editor.ts";
import { CodeMirrorCollaborationController } from "./codemirror-collaboration.ts";
import { codeMirrorPresenceState } from "./codemirror-presence.ts";
import { backlinkField } from "./features/backlinks.ts";
import { mentionRefField } from "./features/mention-refs.ts";

const operationPath = [] as unknown as OperationFieldSnapshot["path"];

function inactiveSnapshot(materialized = "abc") {
  return {
    branch: "",
    id: "of:editor",
    scopeKey: "",
    path: operationPath,
    active: false,
    codec: null,
    cursor: null,
    baselineHash: "baseline",
    materialized,
    operations: [],
  } as const;
}

function statefulView(extensions: unknown[] = []) {
  return {
    hasFocus: false,
    state: EditorState.create({
      doc: "abc",
      extensions: extensions as never[],
    }),
    dispatch(spec: never) {
      this.state = this.state.update(spec).state;
    },
  };
}

class MockPresenceWebSocket {
  static instances: MockPresenceWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: number[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    MockPresenceWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    if (code !== undefined) this.closes.push(code);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const presenceSnapshot = JSON.stringify({
  v: 1,
  type: "room.snapshot",
  selfParticipantId: "11111111-1111-4111-8111-111111111111",
  participants: [],
});

function operationCell(
  runtime: Record<string, unknown>,
  ref: CellRef = {
    space: "did:key:editor-space" as CellRef["space"],
    id: "of:editor-document" as CellRef["id"],
    scope: "space",
    path: ["body"],
  },
  resolvedRef: CellRef = ref,
): CellHandle<string> {
  const makeCell = (cellRef: CellRef): CellHandle<string> => {
    const cell = Object.create(CellHandle.prototype);
    Object.defineProperty(cell, "runtime", { value: () => runtime });
    Object.defineProperty(cell, "ref", { value: () => cellRef });
    Object.defineProperty(cell, "space", { value: () => cellRef.space });
    Object.defineProperty(cell, "resolveAsCell", {
      configurable: true,
      value: () => Promise.resolve(cell),
    });
    return cell;
  };
  const resolved = makeCell(resolvedRef);
  if (resolvedRef === ref) return resolved;
  const source = makeCell(ref);
  Object.defineProperty(source, "resolveAsCell", {
    configurable: true,
    value: () => Promise.resolve(resolved),
  });
  return source;
}

const synchronizedField = {
  space: "did:key:editor-space",
  branch: "main",
  id: "of:editor-document",
  scopeKey: "space",
  path: ["value", "body"],
} as const;

describe("CFCodeEditor collaboration", () => {
  it("routes local, remote, and cell-originated editor updates correctly", () => {
    const calls: string[] = [];
    const collaboration = {
      active: true,
      localDocChanged: () => calls.push("operation"),
    };
    const self = {
      readonly: false,
      language: "text/markdown",
      _collaboration: collaboration,
      _publishPresence: () => calls.push("presence"),
      emit: () => calls.push("change"),
      setValue: () => calls.push("value"),
      _updateMentionedFromContent: () => calls.push("mentioned"),
      _setupPieceNameSubscriptions: () => calls.push("subscriptions"),
      _detectAndSyncNameChanges: () => calls.push("names"),
      _syncMentionRefs: () => calls.push("refs"),
    };
    const invoke = (
      annotation: unknown,
      docChanged = true,
      selectionSet = false,
    ) =>
      (CFCodeEditor.prototype as any)._handleEditorUpdate.call(self, {
        docChanged,
        selectionSet,
        state: { doc: { toString: () => "new" } },
        startState: { doc: { toString: () => "old" } },
        transactions: [{
          annotation: (key: unknown) => key === annotation,
        }],
      });

    invoke(undefined);
    expect(calls).toEqual([
      "operation",
      "presence",
      "change",
      "mentioned",
      "subscriptions",
      "names",
      "refs",
    ]);

    calls.length = 0;
    invoke(Transaction.remote);
    expect(calls).toEqual(["mentioned", "subscriptions"]);

    calls.length = 0;
    const cellSync = (CFCodeEditor as any)._cellSyncAnnotation;
    invoke(cellSync);
    invoke(undefined, false);
    expect(calls).toEqual([]);

    invoke(undefined, false, true);
    expect(calls).toEqual(["presence"]);

    calls.length = 0;
    self._collaboration = undefined as never;
    invoke(undefined);
    expect(calls).toContain("value");
  });

  it("leaves operation authority in charge of ordinary Cell echoes", () => {
    const self = {
      _editorView: {},
      _collaboration: { active: true },
      getValue: () => {
        throw new Error("ordinary Cell value was consulted");
      },
    };

    expect(() =>
      (CFCodeEditor.prototype as any)._updateEditorFromCellValue.call(self)
    ).not.toThrow();
  });

  it("freezes editing and reports a previous-controller stop failure", async () => {
    const events: unknown[] = [];
    const previous = {
      stop: () => Promise.reject("pending edit"),
      dispose: () => events.push("disposed"),
    };
    const element = new CFCodeEditor();
    (element as any)._editorView = { dispatch: () => events.push("dispatch") };
    (element as any)._collaboration = previous;
    (element as any).emit = (_name: string, detail: unknown) =>
      events.push(detail);
    element.collaborative = true;

    await (element as any)._setupCollaboration();

    expect((element as any)._collaboration).toBeUndefined();
    expect(events).toContain("disposed");
    expect((events.at(-1) as { message: string }).message).toBe("pending edit");
  });

  it("requires a CellHandle and restores ordinary editing when disabled", async () => {
    const errors: unknown[] = [];
    const element = new CFCodeEditor();
    (element as any)._editorView = { dispatch: () => {} };
    (element as any).emit = (_name: string, detail: unknown) =>
      errors.push(detail);
    element.collaborative = true;
    element.value = "plain text";
    await (element as any)._setupCollaboration();
    expect((errors[0] as { message: string }).message).toContain("CellHandle");

    let synced = 0;
    element.collaborative = false;
    (element as any)._updateEditorFromCellValue = () => synced++;
    await (element as any)._setupCollaboration();
    expect(synced).toBe(1);
  });

  it("starts a controller and fails closed on a malformed live snapshot", async () => {
    let subscriber: ((snapshot: unknown) => void) | undefined;
    const errors: Array<[string, unknown]> = [];
    const runtime = {
      operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
      queryOperationField: () => Promise.resolve(inactiveSnapshot()),
      subscribeOperationField: (
        _cell: unknown,
        callback: (value: unknown) => void,
      ) => {
        subscriber = callback;
        return Promise.resolve(() => {});
      },
      closeOperationSession: () => Promise.resolve(),
    };
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const collaboration = (element as any)._collaborationComp as Compartment;
    (element as any)._editorView = statefulView([
      readonly.of(EditorState.readOnly.of(false)),
      collaboration.of([]),
    ]);
    (element as any).emit = (name: string, detail: unknown) =>
      errors.push([name, detail]);
    element.value = operationCell(runtime);
    element.collaborative = true;

    await (element as any)._setupCollaboration();
    expect((element as any)._collaboration.active).toBe(true);
    (element as any)._editorView.dispatch({
      changes: { from: 0, insert: "local:" },
    });
    subscriber?.(inactiveSnapshot("canonical"));
    expect(errors.at(-2)?.[0]).toBe("cf-collaboration-reconcile");
    expect(errors.at(-1)?.[0]).toBe("cf-error");
    expect((element as any)._collaborationFailed).toBe(true);

    const invalid = new CFCodeEditor();
    (invalid as any)._editorView = statefulView([
      (invalid as any)._readonly.of(EditorState.readOnly.of(false)),
      (invalid as any)._collaborationComp.of([]),
    ]);
    (invalid as any).emit = (name: string, detail: unknown) =>
      errors.push([name, detail]);
    invalid.value = operationCell({
      operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
      queryOperationField: () =>
        Promise.resolve({ ...inactiveSnapshot(), materialized: 42 }),
      closeOperationSession: () => Promise.resolve(),
    });
    invalid.collaborative = true;
    await (invalid as any)._setupCollaboration();
    expect((invalid as any)._collaborationFailed).toBe(true);
    expect(errors.at(-1)?.[0]).toBe("cf-error");
  });

  it("resolves the bound handle before pinning collaboration identity", async () => {
    const sourceRef: CellRef = {
      space: "did:key:source-space" as CellRef["space"],
      id: "of:alias" as CellRef["id"],
      scope: "space",
      path: ["body"],
    };
    const resolvedRef: CellRef = {
      space: "did:key:target-space" as CellRef["space"],
      id: "computed:document" as CellRef["id"],
      scope: "user",
      path: ["content", "markdown"],
    };
    const snapshot = {
      ...inactiveSnapshot("abc"),
      branch: "main",
      id: resolvedRef.id,
      scopeKey: "user:ada",
      path: [
        "value",
        ...resolvedRef.path,
      ] as unknown as OperationFieldSnapshot["path"],
      active: true,
      codec: CODEMIRROR_CHANGESET_CODEC,
      cursor: { epoch: 1, version: 0 },
    } as const;
    let openedCell: CellHandle<string> | undefined;
    const runtime = {
      operationCodecs: (cell: CellHandle<string>) => {
        openedCell = cell;
        return Promise.resolve([CODEMIRROR_CHANGESET_CODEC]);
      },
      queryOperationField: () => Promise.resolve(snapshot),
      subscribeOperationField: () => Promise.resolve(() => {}),
      closeOperationSession: () => Promise.resolve(),
    };
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const collaboration = (element as any)
      ._collaborationComp as Compartment;
    (element as any)._editorView = statefulView([
      readonly.of(EditorState.readOnly.of(false)),
      collaboration.of([]),
    ]);
    element.value = operationCell(runtime, sourceRef, resolvedRef);
    element.collaborative = true;

    await (element as any)._setupCollaboration();

    expect(openedCell?.ref()).toEqual(resolvedRef);
    expect((element as any)._collaboration.synchronizationSnapshot.field)
      .toEqual({
        space: "did:key:target-space",
        branch: "main",
        id: "computed:document",
        scopeKey: "user:ada",
        path: ["value", "content", "markdown"],
      });
  });

  it("uses the host endpoint context until an explicit override is set", () => {
    const originalWebSocket = globalThis.WebSocket;
    MockPresenceWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: MockPresenceWebSocket,
    });
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      const collaboration = {
        active: true,
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: synchronizedField,
        },
      };
      (element as any)._collaboration = collaboration;
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";
      element.contextPresenceUrl = "wss://default-presence.example";

      (element as any)._takePresenceOwnership();
      expect(MockPresenceWebSocket.instances[0].url).toBe(
        "wss://default-presence.example/v1/rooms/abcdefghijklmnopqrstuv",
      );

      element.participantName = "Grace";
      (element as any)._setupPresence();
      expect(MockPresenceWebSocket.instances).toHaveLength(1);

      collaboration.synchronizationSnapshot = {
        confirmedCursor: { epoch: 3, version: 0 },
        pendingChanges: [],
        field: synchronizedField,
      };
      (element as any)._handleCollaborationSynchronization(
        collaboration.synchronizationSnapshot,
      );
      expect(MockPresenceWebSocket.instances).toHaveLength(2);
      expect(MockPresenceWebSocket.instances[0].closes).toEqual([1000]);

      element.presenceUrl = "wss://override-presence.example";
      (element as any)._setupPresence();
      expect(MockPresenceWebSocket.instances[2].url).toBe(
        "wss://override-presence.example/v1/rooms/abcdefghijklmnopqrstuv",
      );
      expect(MockPresenceWebSocket.instances[1].closes).toEqual([1000]);

      element.presenceRoom = "zyxwvutsrqponmlkjihgfe";
      (element as any)._setupPresence();
      expect(MockPresenceWebSocket.instances).toHaveLength(4);
      expect(MockPresenceWebSocket.instances[2].closes).toEqual([1000]);

      element.presenceRoom = "";
      (element as any)._setupPresence();
      expect(MockPresenceWebSocket.instances).toHaveLength(5);
      expect(MockPresenceWebSocket.instances[4].url).toMatch(
        /^wss:\/\/override-presence\.example\/v1\/rooms\/[A-Za-z0-9_-]{43}$/,
      );
      expect(MockPresenceWebSocket.instances[3].closes).toEqual([1000]);
    } finally {
      (element as any)._releasePresenceOwnership();
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: originalWebSocket,
      });
    }
  });

  it("derives a room from the bound text cell when no override is set", () => {
    const originalWebSocket = globalThis.WebSocket;
    MockPresenceWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: MockPresenceWebSocket,
    });
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      (element as any)._collaboration = {
        active: true,
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: {
            space: "did:key:resolved-space",
            branch: "main",
            id: "of:note-document",
            scopeKey: "user:ada",
            path: ["value", "content", "markdown"],
          },
        },
      };
      element.value = operationCell({}, {
        space: "did:key:shared-space" as CellRef["space"],
        id: "of:note-document" as CellRef["id"],
        scope: "space",
        path: ["content", "markdown"],
      });
      element.collaborative = true;
      element.participantName = "Ada";
      element.contextPresenceUrl = "wss://default-presence.example";

      (element as any)._takePresenceOwnership();

      expect(MockPresenceWebSocket.instances).toHaveLength(1);
      expect(MockPresenceWebSocket.instances[0].url).toMatch(
        /^wss:\/\/default-presence\.example\/v1\/rooms\/[A-Za-z0-9_-]{43}$/,
      );
    } finally {
      (element as any)._releasePresenceOwnership();
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: originalWebSocket,
      });
    }
  });

  it("moves the page presence session between focused editors", () => {
    const originalWebSocket = globalThis.WebSocket;
    MockPresenceWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: MockPresenceWebSocket,
    });
    const createEditor = (room: string) => {
      const element = new CFCodeEditor();
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      (element as any)._collaboration = {
        active: true,
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: synchronizedField,
        },
      };
      element.collaborative = true;
      element.presenceRoom = room;
      element.participantName = "Ada";
      element.presenceUrl = "wss://presence.example";
      return element;
    };
    const first = createEditor("aaaaaaaaaaaaaaaaaaaaaa");
    const second = createEditor("bbbbbbbbbbbbbbbbbbbbbb");
    try {
      (first as any)._setupPresence();
      (second as any)._setupPresence();
      expect(MockPresenceWebSocket.instances).toHaveLength(0);

      ((first as any)._editorView as { hasFocus: boolean }).hasFocus = true;
      (first as any)._handlePresenceFocus();
      expect(MockPresenceWebSocket.instances).toHaveLength(1);
      expect(MockPresenceWebSocket.instances[0].url).toContain(
        "/rooms/aaaaaaaaaaaaaaaaaaaaaa",
      );

      (first as any)._publishPresence();
      expect(MockPresenceWebSocket.instances[0].closes).toEqual([]);

      ((first as any)._editorView as { hasFocus: boolean }).hasFocus = false;
      ((second as any)._editorView as { hasFocus: boolean }).hasFocus = true;
      (second as any)._handlePresenceFocus();
      expect(MockPresenceWebSocket.instances[0].closes).toEqual([1000]);
      expect(MockPresenceWebSocket.instances).toHaveLength(2);
      expect(MockPresenceWebSocket.instances[1].url).toContain(
        "/rooms/bbbbbbbbbbbbbbbbbbbbbb",
      );

      (first as any)._setupPresence();
      expect(MockPresenceWebSocket.instances).toHaveLength(2);

      (second as any)._releasePresenceOwnership();
      expect(MockPresenceWebSocket.instances[1].closes).toEqual([1000]);
      (first as any)._setupPresence();
      expect(MockPresenceWebSocket.instances).toHaveLength(2);
    } finally {
      (first as any)._releasePresenceOwnership?.();
      (second as any)._releasePresenceOwnership?.();
      (first as any)._cleanupPresence();
      (second as any)._cleanupPresence();
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: originalWebSocket,
      });
    }
  });

  it("publishes no selection before focus and retains it after blur", () => {
    const originalWebSocket = globalThis.WebSocket;
    const originalRequestFrame = globalThis.requestAnimationFrame;
    const originalCancelFrame = globalThis.cancelAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    MockPresenceWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: MockPresenceWebSocket,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => {},
    });
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      const view = statefulView([presence.of([])]);
      view.hasFocus = false;
      view.dispatch({ selection: { anchor: 1, head: 2 } } as never);
      (element as any)._editorView = view;
      (element as any)._collaboration = {
        active: true,
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: synchronizedField,
        },
      };
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";
      element.presenceUrl = "wss://presence.example";

      (element as any)._takePresenceOwnership();
      const socket = MockPresenceWebSocket.instances[0];
      socket.readyState = 1;
      socket.emit("open");
      socket.emit("message", { data: presenceSnapshot });
      frames.shift()?.(0);
      expect(JSON.parse(socket.sent[0])).toMatchObject({
        name: "Ada",
        focused: false,
        cursor: { epoch: 2, version: 4 },
        selection: null,
        basis: "confirmed",
      });

      view.hasFocus = true;
      (element as any)._publishPresence();
      frames.shift()?.(0);
      expect(JSON.parse(socket.sent[1])).toMatchObject({
        revision: 2,
        focused: true,
        selection: {
          ranges: [{ anchor: 1, head: 2, assoc: -1 }],
          main: 0,
        },
      });

      view.hasFocus = false;
      (element as any)._publishPresence();
      frames.shift()?.(0);
      expect(JSON.parse(socket.sent[2])).toMatchObject({
        revision: 3,
        focused: false,
        selection: {
          ranges: [{ anchor: 1, head: 2, assoc: -1 }],
          main: 0,
        },
      });
    } finally {
      (element as any)._releasePresenceOwnership();
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: originalWebSocket,
      });
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: originalRequestFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: originalCancelFrame,
      });
    }
  });

  it("reports presence failure without making Memory collaboration read-only", () => {
    const events: Array<[string, unknown]> = [];
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const presence = (element as any)._presenceComp as Compartment;
    const view = statefulView([
      readonly.of(EditorState.readOnly.of(false)),
      presence.of([]),
    ]);
    const collaboration = { active: true };
    (element as any)._editorView = view;
    (element as any)._collaboration = collaboration;
    (element as any)._presence = { dispose: () => {} };
    (element as any).emit = (name: string, detail: unknown) =>
      events.push([name, detail]);

    (element as any)._failPresence("protocol");

    expect((element as any)._collaboration).toBe(collaboration);
    expect(view.state.readOnly).toBe(false);
    expect(events).toEqual([["cf-presence-error", { category: "protocol" }]]);
  });

  it("reports invalid host configuration once until the endpoint changes", () => {
    const originalWebSocket = globalThis.WebSocket;
    MockPresenceWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: MockPresenceWebSocket,
    });
    const events: Array<[string, unknown]> = [];
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      (element as any)._collaboration = {
        active: true,
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 1, version: 0 },
          pendingChanges: [],
          field: synchronizedField,
        },
      };
      (element as any).emit = (name: string, detail: unknown) =>
        events.push([name, detail]);
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";
      element.contextPresenceUrl = "https://presence.example";

      (element as any)._takePresenceOwnership();
      (element as any)._setupPresence();
      (element as any)._retryPresenceFromSignal();

      expect((element as any)._collaboration.active).toBe(true);
      expect(events).toEqual([
        ["cf-presence-error", { category: "configuration" }],
      ]);
      expect(MockPresenceWebSocket.instances).toHaveLength(0);

      element.contextPresenceUrl = "wss://presence.example";
      (element as any)._setupPresence();
      expect(MockPresenceWebSocket.instances).toHaveLength(1);
    } finally {
      (element as any)._releasePresenceOwnership();
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: originalWebSocket,
      });
    }
  });

  it("reconnects a failed presence session only after an explicit signal", () => {
    const originalWebSocket = globalThis.WebSocket;
    MockPresenceWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: MockPresenceWebSocket,
    });
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      const synchronizationSnapshot = {
        confirmedCursor: { epoch: 1, version: 0 },
        pendingChanges: [],
        field: synchronizedField,
      };
      (element as any)._collaboration = {
        active: true,
        synchronizationSnapshot,
      };
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";
      element.presenceUrl = "wss://presence.example";

      (element as any)._takePresenceOwnership();
      const failedSocket = MockPresenceWebSocket.instances[0];
      failedSocket.emit("error");
      expect(failedSocket.closes).toEqual([1002]);

      (element as any)._handleCollaborationSynchronization(
        synchronizationSnapshot,
      );
      expect(MockPresenceWebSocket.instances).toHaveLength(1);

      (element as any)._retryPresenceFromSignal();
      expect(MockPresenceWebSocket.instances).toHaveLength(2);
      const reconnectedSocket = MockPresenceWebSocket.instances[1];
      reconnectedSocket.readyState = 1;
      reconnectedSocket.emit("open");
      reconnectedSocket.emit("message", { data: presenceSnapshot });
      expect((element as any)._presenceParticipantId).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
    } finally {
      (element as any)._releasePresenceOwnership();
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: originalWebSocket,
      });
    }
  });

  it("listens for online and visible signals only while connected", () => {
    const originalDocument = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );
    const fakeDocument = new EventTarget() as EventTarget & {
      visibilityState: string;
    };
    fakeDocument.visibilityState = "visible";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: fakeDocument,
    });
    const element = new CFCodeEditor();
    let retries = 0;
    (element as any)._retryPresenceFromSignal = () => retries++;
    try {
      (element as any)._setupPresenceReconnectListeners();
      globalThis.dispatchEvent(new Event("online"));
      fakeDocument.dispatchEvent(new Event("visibilitychange"));
      expect(retries).toBe(2);

      (element as any)._cleanupPresenceReconnectListeners();
      globalThis.dispatchEvent(new Event("online"));
      fakeDocument.dispatchEvent(new Event("visibilitychange"));
      expect(retries).toBe(2);
    } finally {
      (element as any)._cleanupPresenceReconnectListeners();
      if (originalDocument) {
        Object.defineProperty(globalThis, "document", originalDocument);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("submits external backlink title rewrites through collaboration", async () => {
    let state = EditorState.create({
      doc: "[[Old (piece:1)]]",
      extensions: [backlinkField],
    });
    const events: Array<[string, unknown]> = [];
    let localChanges = 0;
    let reads = 0;
    const self = {
      language: "text/markdown",
      _editorView: {
        get state() {
          return state;
        },
        dispatch(spec: never) {
          state = state.update(spec).state;
        },
      },
      _collaboration: {
        active: true,
        prepareExternalChange: () => Promise.resolve(true),
        localDocChanged: () => localChanges++,
      },
      _previousBacklinkNames: new Map(),
      emit: (name: string, detail: unknown) => events.push([name, detail]),
      _updateMentionedFromContent: () => {},
      setValue: () => {
        throw new Error("ordinary value path used");
      },
    };
    const piece = {
      key: () => ({
        get: () => reads++ === 0 ? "New" : "📝 New",
      }),
    };

    await (CFCodeEditor.prototype as any)._handleExternalTitleChange.call(
      self,
      "piece:1",
      piece,
    );

    expect(state.doc.toString()).toBe("[[📝 New (piece:1)]]");
    expect(localChanges).toBe(1);
    expect(events[0][0]).toBe("cf-change");
  });

  it("submits external reference title rewrites through collaboration", async () => {
    let state = EditorState.create({
      doc: "[Old][ref-1]",
      extensions: [mentionRefField],
    });
    const events: Array<[string, unknown]> = [];
    let localChanges = 0;
    const self = {
      language: "text/markdown",
      _editorView: {
        get state() {
          return state;
        },
        dispatch(spec: never) {
          state = state.update(spec).state;
        },
      },
      _refMap: () => ({ "ref-1": { modifiedTitle: false } }),
      _documentRefs: () => [{
        key: "ref-1",
        label: "Old",
        labelFrom: 1,
        labelTo: 4,
      }],
      _collaboration: {
        active: true,
        prepareExternalChange: () => Promise.resolve(true),
        localDocChanged: () => localChanges++,
      },
      _previousRefLabels: new Map(),
      emit: (name: string, detail: unknown) => events.push([name, detail]),
      _updateMentionedFromContent: () => {},
      setValue: () => {
        throw new Error("ordinary value path used");
      },
    };

    await (CFCodeEditor.prototype as any)._handleExternalRefTitleChange.call(
      self,
      "ref-1",
      "New",
    );

    expect(state.doc.toString()).toBe("[New][ref-1]");
    expect(localChanges).toBe(1);
    expect(events[0][0]).toBe("cf-change");
  });

  it("confirms ordinary local edits before an external rewrite", async () => {
    let state = EditorState.create({
      doc: "draft [[Old (piece:1)]]",
      extensions: [backlinkField],
    });
    const firstFlush = Promise.withResolvers<void>();
    let flushes = 0;
    const collaboration = {
      active: true,
      prepareExternalChange: () => {
        flushes++;
        return firstFlush.promise.then(() => true);
      },
      localDocChanged: () => {
        flushes++;
        return Promise.resolve();
      },
    };
    const self = {
      language: "text/markdown",
      _editorView: {
        get state() {
          return state;
        },
        dispatch(spec: never) {
          state = state.update(spec).state;
        },
      },
      _collaboration: collaboration,
      _previousBacklinkNames: new Map(),
      emit: () => {},
      _updateMentionedFromContent: () => {},
      setValue: () => {
        throw new Error("ordinary value path used");
      },
    };
    const piece = {
      key: (key: string) => ({
        get: () => key === "title" ? "New" : "📝 New",
      }),
    };

    const rewriting = (CFCodeEditor.prototype as any)
      ._handleExternalTitleChange.call(self, "piece:1", piece);
    await Promise.resolve();
    expect(state.doc.toString()).toBe("draft [[Old (piece:1)]]");

    firstFlush.resolve();
    await rewriting;
    expect(state.doc.toString()).toBe("draft [[📝 New (piece:1)]]");
    expect(flushes).toBe(2);
  });

  it("reports a final send that fails while detaching", async () => {
    const events: unknown[] = [];
    const element = new CFCodeEditor();
    (element as any)._collaboration = {
      active: true,
      stop: () => Promise.reject(new Error("pending edit")),
    };
    (element as any).emit = (name: string, detail: unknown) =>
      events.push([name, detail]);
    element.collaborative = true;

    (element as any)._cleanupCollaboration();
    await Promise.resolve();
    await Promise.resolve();

    expect((element as any)._collaboration).toBeUndefined();
    expect(events).toEqual([
      ["cf-error", {
        error: new Error("pending edit"),
        message: "pending edit",
      }],
    ]);
  });

  it("detaches without releasing and explicitly releases active collaboration", async () => {
    const events: string[] = [];
    const element = new CFCodeEditor();
    (element as any)._collaboration = {
      active: true,
      stop: () => Promise.reject(new Error("ignored on disconnect")),
      release: () => {
        events.push("release");
        return Promise.resolve();
      },
    };
    element.collaborative = true;
    element.requestUpdate = () => events.push("update");

    (element as any)._cleanupCollaboration();
    await Promise.resolve();
    expect((element as any)._collaboration).toBeUndefined();

    const active = {
      active: true,
      release: () => {
        events.push("release");
        return Promise.resolve();
      },
    };
    (element as any)._collaboration = active;
    await element.releaseCollaboration();
    expect(element.collaborative).toBe(false);
    expect(events).toContain("release");
    expect(events).toContain("update");

    (element as any)._collaboration = undefined;
    await element.releaseCollaboration();
    (element as any)._cleanupCollaboration();
  });

  it("makes the editor read-only before release settles", async () => {
    const release = Promise.withResolvers<void>();
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const collaboration = (element as any)._collaborationComp as Compartment;
    const view = statefulView([
      readonly.of(EditorState.readOnly.of(false)),
      collaboration.of([]),
    ]);
    (element as any)._editorView = view;
    (element as any)._collaboration = {
      active: true,
      release: () => release.promise,
    };

    const releasing = element.releaseCollaboration();
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    release.resolve();
    await releasing;
  });

  it("restores synchronization and presence when release fails", async () => {
    const originalWebSocket = globalThis.WebSocket;
    MockPresenceWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: MockPresenceWebSocket,
    });
    const element = new CFCodeEditor();
    try {
      const readonly = (element as any)._readonly as Compartment;
      const collaborationComp = (element as any)
        ._collaborationComp as Compartment;
      const presence = (element as any)._presenceComp as Compartment;
      const view = statefulView([
        readonly.of(EditorState.readOnly.of(false)),
        collaborationComp.of([]),
        presence.of([]),
      ]);
      const snapshot = {
        confirmedCursor: { epoch: 1, version: 3 },
        pendingChanges: [],
        field: synchronizedField,
      };
      let observerRegistrations = 0;
      const collaboration = {
        active: true,
        synchronizationSnapshot: snapshot,
        release: () => Promise.reject(new Error("release failed")),
        observeSynchronization: (
          observer: (value: typeof snapshot) => void,
        ) => {
          observerRegistrations++;
          observer(snapshot);
          return () => {};
        },
      };
      (element as any)._editorView = view;
      (element as any)._collaboration = collaboration;
      (element as any)._collaborationSyncUnsub = () => {};
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";
      element.presenceUrl = "wss://presence.example";
      (element as any)._takePresenceOwnership();

      let failure: unknown;
      try {
        await element.releaseCollaboration();
      } catch (error) {
        failure = error;
      }

      expect((failure as Error).message).toBe("release failed");
      expect(observerRegistrations).toBe(1);
      expect(MockPresenceWebSocket.instances).toHaveLength(2);
      expect(MockPresenceWebSocket.instances[0].closes).toEqual([1000]);
      expect((element as any)._presence).toBeDefined();
      expect(view.state.facet(EditorState.readOnly)).toBe(false);
      expect((element as any)._collaboration).toBe(collaboration);
    } finally {
      (element as any)._releasePresenceOwnership();
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: originalWebSocket,
      });
    }
  });

  it("clears presence before a new Memory epoch replaces the document", async () => {
    const originalWebSocket = globalThis.WebSocket;
    MockPresenceWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: MockPresenceWebSocket,
    });
    const initial: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path: operationPath,
      active: true,
      codec: CODEMIRROR_CHANGESET_CODEC,
      cursor: { epoch: 1, version: 0 },
      baselineHash: "baseline:1",
      materialized: "abc",
      operations: [],
    };
    let subscriber:
      | ((snapshot: OperationFieldSnapshot) => void)
      | undefined;
    const runtime = {
      operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
      queryOperationField: () => Promise.resolve(initial),
      subscribeOperationField: (
        _cell: CellHandle<string>,
        callback: (snapshot: OperationFieldSnapshot) => void,
      ) => {
        subscriber = callback;
        return Promise.resolve(() => {});
      },
      closeOperationSession: () => Promise.resolve(),
    };
    const element = new CFCodeEditor();
    const collaborationComp = (element as any)
      ._collaborationComp as Compartment;
    const presenceComp = (element as any)._presenceComp as Compartment;
    let state = EditorState.create({
      doc: "abc",
      extensions: [collaborationComp.of([]), presenceComp.of([])],
    });
    let presenceInstalledAtReplacement: boolean | undefined;
    const view = {
      hasFocus: false,
      get state() {
        return state;
      },
      dispatch(...specs: readonly TransactionSpec[]) {
        const transaction = state.update(...specs);
        if (
          transaction.docChanged && transaction.newDoc.toString() === "reset"
        ) {
          presenceInstalledAtReplacement =
            codeMirrorPresenceState(state) !== undefined;
        }
        state = transaction.state;
      },
    } as unknown as EditorView;
    const controller = new CodeMirrorCollaborationController({
      runtime: runtime as never,
      cell: operationCell(runtime),
      view,
      compartment: collaborationComp,
      onError: (error) => {
        throw error;
      },
    });

    try {
      await controller.start();
      (element as any)._editorView = view;
      (element as any)._collaboration = controller;
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";
      element.presenceUrl = "wss://presence.example";
      (element as any)._takePresenceOwnership();
      (element as any)._observeCollaboration(controller);
      expect(codeMirrorPresenceState(view.state)).toBeDefined();

      subscriber?.({
        ...initial,
        cursor: { epoch: 2, version: 0 },
        baselineHash: "baseline:2",
        materialized: "reset",
      });

      expect(presenceInstalledAtReplacement).toBe(false);
      expect(view.state.doc.toString()).toBe("reset");
      expect((element as any)._presenceEpoch).toBe(2);
    } finally {
      (element as any)._collaborationSyncUnsub?.();
      (element as any)._releasePresenceOwnership();
      controller.dispose();
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: originalWebSocket,
      });
    }
  });

  it("defers a programmatic title rewrite until release settles", async () => {
    const release = Promise.withResolvers<void>();
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const collaborationComp = (element as any)
      ._collaborationComp as Compartment;
    const view = {
      state: EditorState.create({
        doc: "[[Old (piece:1)]]",
        extensions: [
          readonly.of(EditorState.readOnly.of(false)),
          collaborationComp.of([]),
          backlinkField,
        ],
      }),
      dispatch(spec: never) {
        this.state = this.state.update(spec).state;
      },
    };
    (element as any)._editorView = view;
    (element as any)._collaboration = {
      active: true,
      release: () => release.promise,
    };
    (element as any)._updateMentionedFromContent = () => {};
    let persisted: string | undefined;
    (element as any).setValue = (value: string) => persisted = value;
    (element as any)._cellController = { flush: () => {} };
    const piece = {
      key: (key: string) => ({
        get: () => key === "title" ? "New" : "📝 New",
      }),
    };

    const releasing = element.releaseCollaboration();
    const rewriting = (element as any)._handleExternalTitleChange(
      "piece:1",
      piece,
    );
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("[[Old (piece:1)]]");

    release.resolve();
    await Promise.all([releasing, rewriting]);
    expect(view.state.doc.toString()).toBe("[[📝 New (piece:1)]]");
    expect(persisted).toBe("[[📝 New (piece:1)]]");
  });

  it("handles superseded setup and reactive collaboration lifecycle hooks", async () => {
    const element = new CFCodeEditor();
    await (element as any)._setupCollaboration();

    const dispatches: unknown[] = [];
    (element as any)._editorView = {
      dispatch: (value: unknown) => dispatches.push(value),
    };
    const previous = {
      stop: () => Promise.resolve(),
      dispose: () => {},
    };
    (element as any)._collaboration = previous;
    element.collaborative = false;
    (element as any)._updateEditorFromCellValue = () => {};
    await (element as any)._setupCollaboration();
    expect((element as any)._collaboration).toBeUndefined();

    let setup = 0;
    (element as any)._setupCollaboration = () => {
      setup++;
      return Promise.resolve();
    };
    Object.defineProperty(element, "hasUpdated", { value: true });
    element.updated(new Map([["collaborative", false]]));
    expect(setup).toBe(1);

    (element as any)._collaborationFailed = true;
    element.updated(new Map([["readonly", false]]));
    expect(dispatches.length).toBeGreaterThan(0);

    const noMentions = {
      mentioned: null,
      getValue: () => "value",
    };
    (CFCodeEditor.prototype as any)._updateMentionedFromContent.call(
      noMentions,
    );
  });
});
