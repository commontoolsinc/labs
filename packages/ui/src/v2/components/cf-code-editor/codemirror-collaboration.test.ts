import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { receiveUpdates, sendableUpdates } from "@codemirror/collab";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
import type { OperationFieldSnapshot } from "@commonfabric/runtime-client";
import {
  codeMirrorCollaboration,
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
});

function receiveState(
  state: EditorState,
  snapshot: OperationFieldSnapshot,
  cursor: { epoch: number; version: number },
): EditorState {
  const updates = codeMirrorIntegratedUpdates(snapshot, cursor);
  return receiveUpdates(state, updates).state;
}
