import {
  action,
  assert,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";
import Note from "../notes/note.tsx";
import {
  default as EmailTaskEngine,
  executeCreateNote,
  executeEditNote,
  type NotePiece,
} from "./email-task-engine.tsx";

const recordRemovedLabel = handler<
  { messageId: string; labels: string[] },
  { removals: Writable<string[]> }
>(({ messageId, labels }, { removals }) => {
  removals.push(`${messageId}:${labels.join(",")}`);
});

export default pattern(() => {
  const subject = EmailTaskEngine({});
  const existingNote = Note({
    title: "Project Plan",
    content: "Existing details",
  });
  const pieceRegistry = new Writable<NotePiece[]>([]);
  const taskCurrentLabelId = new Writable("task-current-id");
  const hiddenTasks = new Writable<string[]>([]);
  const processingTasks = new Writable<string[]>([]);
  const removals = new Writable<string[]>([]);
  const removeLabels = recordRemovedLabel({ removals });

  const editNote: Stream<Record<string, never>> = executeEditNote({
    removeLabels,
    emailId: "edit-email",
    noteTitle: "Project Plan",
    addition: "New action item",
    taskCurrentLabelId,
    hiddenTasks,
    processingTasks,
    pieceRegistry,
  });
  const createNote: Stream<Record<string, never>> = executeCreateNote({
    removeLabels,
    emailId: "create-email",
    title: "Follow-up",
    content: "Send the status update",
    taskCurrentLabelId,
    hiddenTasks,
    processingTasks,
    pieceRegistry,
  });

  const action_edit_note = action(() => editNote.send({}));
  const action_create_note = action(() => createNote.send({}));
  const action_register_existing_note = action(() => {
    pieceRegistry.push(existingNote);
  });

  const assert_edit_uses_registry_cell = assert(() =>
    pieceRegistry.get()[0]?.content ===
      "Existing details\n\nNew action item" &&
    hiddenTasks.get().includes("edit-email") &&
    processingTasks.get().length === 0 &&
    removals.get()[0] === "edit-email:task-current-id"
  );
  const assert_create_registers_note = assert(() =>
    pieceRegistry.get().length === 2 &&
    pieceRegistry.get()[1]?.title === "Follow-up" &&
    hiddenTasks.get().includes("create-email") &&
    processingTasks.get().length === 0 &&
    removals.get()[1] === "create-email:task-current-id"
  );
  const assert_engine_starts_without_tasks = assert(() =>
    subject.taskCount === 0 && subject.analyses.length === 0
  );

  return {
    tests: [
      { assertion: assert_engine_starts_without_tasks },
      { action: action_register_existing_note },
      { action: action_edit_note },
      { assertion: assert_edit_uses_registry_cell },
      { action: action_create_note },
      { assertion: assert_create_registers_note },
    ],
    subject,
  };
});
