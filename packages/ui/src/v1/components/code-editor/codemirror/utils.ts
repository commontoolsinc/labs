import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const replaceSource = (state: EditorState, value: string) =>
  state.update({
    changes: {
      from: 0,
      to: state.doc.length,
      insert: value,
    },
  });

/** Replace the source in this editor view, but only if it's different */
export const replaceSourceIfNeeded = (view: EditorView, value: string) => {
  if (view.state.doc.toString() === value) return;
  view.dispatch(
    view.state.update({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: value,
      },
    }),
  );
};

export type CancelGroup = {
  add: (fn: () => void) => void;
  cancel: () => void;
};

export function createCancelGroup(): CancelGroup {
  const callbacks: Array<() => void> = [];
  
  return {
    add: (fn: () => void) => {
      callbacks.push(fn);
    },
    cancel: () => {
      for (const fn of callbacks) {
        fn();
      }
      callbacks.length = 0;
    }
  };
}
