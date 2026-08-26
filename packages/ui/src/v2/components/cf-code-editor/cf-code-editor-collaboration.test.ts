import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  CellHandle,
  CODEMIRROR_CHANGESET_CODEC,
} from "@commonfabric/runtime-client";
import { CFCodeEditor } from "./cf-code-editor.ts";

const operationPath = [] as never[];

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
    state: EditorState.create({
      doc: "abc",
      extensions: extensions as never[],
    }),
    dispatch(spec: never) {
      this.state = this.state.update(spec).state;
    },
  };
}

function operationCell(runtime: Record<string, unknown>): CellHandle<string> {
  const cell = Object.create(CellHandle.prototype);
  Object.defineProperty(cell, "runtime", { value: () => runtime });
  return cell;
}

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
      emit: () => calls.push("change"),
      setValue: () => calls.push("value"),
      _updateMentionedFromContent: () => calls.push("mentioned"),
      _setupPieceNameSubscriptions: () => calls.push("subscriptions"),
      _detectAndSyncNameChanges: () => calls.push("names"),
      _syncMentionRefs: () => calls.push("refs"),
    };
    const invoke = (annotation: unknown, docChanged = true) =>
      (CFCodeEditor.prototype as any)._handleEditorUpdate.call(self, {
        docChanged,
        state: { doc: { toString: () => "new" } },
        startState: { doc: { toString: () => "old" } },
        transactions: [{
          annotation: (key: unknown) => key === annotation,
        }],
      });

    invoke(undefined);
    expect(calls).toEqual([
      "operation",
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
    subscriber?.({ ...inactiveSnapshot(), materialized: 42 });
    expect(errors.at(-1)?.[0]).toBe("cf-error");
    expect((element as any)._collaborationFailed).toBe(true);
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
  });
});
