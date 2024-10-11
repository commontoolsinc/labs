import { EditorView } from "prosemirror-view";
import {
  Command,
  EditorState,
  Transaction,
  TextSelection,
} from "prosemirror-state";

/** Execute a command on the view, mutating it. */
export const executeCommand = (view: EditorView, command: Command) => {
  command(view.state, (tr) => view.dispatch(tr));
};

/**
 * Wraps a function, turning it into a command
 * Commands are are building block functions that encapsulate an editing action.
 * They're the preferred way to set ProseMirror state.
 *
 * Commands have an awkward signature.
 * When a command isn't applicable, it should return false and do nothing.
 * When it is, it should dispatch a transaction and return true.
 * However, the dispatch function may not always be available.
 * This helper decorates a simpler function sig so that it becomes a command.
 * @see https://prosemirror.net/docs/guide/#commands
 * @see https://prosemirror.net/docs/ref/version/0.20.0.html#commands
 */
export const command =
  (
    definition: (state: EditorState) => Transaction | null | undefined,
  ): Command =>
  (
    state: EditorState,
    dispatch?: (tr: Transaction) => void,
    _view?: EditorView,
  ) => {
    if (dispatch == null) return false;
    const tr = definition(state);
    if (tr == null) return false;
    dispatch(tr);
    return true;
  };

/**
 * Replace range with text, placing cursor at end
 */
export const replaceWithText = (from: number, to: number, text: string) =>
  command((state) => {
    const tr = state.tr;
    tr.delete(from, to);
    tr.insertText(text, from);
    const pos = from + text.length;
    tr.setSelection(TextSelection.create(tr.doc, pos));
    return tr;
  });
