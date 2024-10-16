import { EditorState, Plugin, PluginKey, Transaction } from "prosemirror-state";
import cid from "../../../shared/cid.js";
import { EditorView } from "prosemirror-view";
import { debug } from "../../../shared/debug.js";

/** Generates a unique client ID version for each state change */
const verPluginKey = new PluginKey("ver");

export const verPlugin = new Plugin({
  key: verPluginKey,
  state: {
    init() {
      return cid();
    },
    apply(tr, _prev) {
      return tr.getMeta(verPluginKey) ?? cid();
    },
  },
});

export const getVer = (state: EditorState) => verPluginKey.getState(state);

export const setVer = (tr: Transaction, version: string = cid()): Transaction =>
  tr.setMeta(verPluginKey, version);

export const updateState = (
  state: EditorState,
  transact: (state: EditorState) => Transaction,
): EditorState => state.apply(setVer(transact(state)));

/** Use version to check equality */
export const isVerEqual = (curr: EditorState, next: EditorState): boolean =>
  getVer(curr) === getVer(next);

/** Apply state to editor view, but only if version does not match */
export const updateVerState = (
  view: EditorView,
  state: EditorState,
): boolean => {
  if (isVerEqual(view.state, state)) {
    if (debug()) console.info("State version matches existing editor state");
    return false;
  }
  view.updateState(state);
  return true;
};
