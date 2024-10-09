import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { isBetweenInclusive } from "../../shared/number.js";
import { Rect } from "../../shared/position.js";
import { debug } from "../../shared/debug.js";

export type Suggestion = {
  from: number;
  to: number;
  active: boolean;
  text: string;
};

const freeze = Object.freeze;

/// Create a frozen suggestion
export const createSuggestion = (
  from: number,
  to: number,
  active: boolean,
  text: string,
): Suggestion => freeze({ from, to, active, text });

export const isSuggestionActive = (suggestion: Suggestion) => suggestion.active;

/** Get the rect representing the suggestion range */
export const getSuggestionRect = (
  view: EditorView,
  suggestion: Suggestion,
): Rect => {
  const fromRect = view.coordsAtPos(suggestion.from);
  const toRect = view.coordsAtPos(suggestion.to);
  return {
    left: fromRect.left,
    right: toRect.right,
    top: toRect.top,
    bottom: toRect.bottom,
  };
};

export const getActiveSuggestion = (
  suggestions: Array<Suggestion> | undefined | null,
): Suggestion | null => suggestions?.find(isSuggestionActive) ?? null;

export const createInitMsg = () =>
  freeze({
    type: "init",
  });

export const createUpdateMsg = (suggestion: Suggestion | null) =>
  freeze({
    type: "update",
    suggestion,
  });

export const createDestroyMsg = () =>
  freeze({
    type: "destroy",
  });

export const createArrowDownMsg = () =>
  freeze({
    type: "arrowDown",
  });

export const createArrowUpMsg = () =>
  freeze({
    type: "arrowUp",
  });

export const createTabMsg = (suggestion: Suggestion) =>
  freeze({
    type: "tab",
    suggestion,
  });

export const createEnterMsg = (suggestion: Suggestion) =>
  freeze({
    type: "enter",
    suggestion,
  });

export type Msg =
  | ReturnType<typeof createInitMsg>
  | ReturnType<typeof createUpdateMsg>
  | ReturnType<typeof createDestroyMsg>
  | ReturnType<typeof createArrowDownMsg>
  | ReturnType<typeof createArrowUpMsg>
  | ReturnType<typeof createTabMsg>
  | ReturnType<typeof createEnterMsg>;

export const suggestionsPlugin = ({
  pattern,
  decoration,
  reducer,
}: {
  pattern: RegExp;
  decoration: (suggestion: Suggestion) => Decoration;
  reducer: (view: EditorView, msg: Msg) => boolean;
}) => {
  const source = "suggestionsPlugin";

  return new Plugin({
    key: new PluginKey("suggestions"),

    view(view: EditorView) {
      const msg = createInitMsg();
      if (debug()) console.debug(source, msg);
      reducer(view, msg);

      return {
        update: (view: EditorView, _prevState: EditorState) => {
          const state = view.state;
          const active = getActiveSuggestion(this.key?.getState(state));
          const msg = createUpdateMsg(active);
          if (debug()) console.debug(source, msg);
          reducer(view, msg);
        },
        destroy: () => {
          const msg = createDestroyMsg();
          if (debug()) console.debug(source, msg);
          reducer(view, msg);
        },
      };
    },

    state: {
      init(): Array<Suggestion> {
        return [];
      },

      apply(tr, _prev, _oldState, newState): Array<Suggestion> {
        // Match all suggestions in text for every state change and build up
        // an array of suggestions for plugin state.
        // We'll use this array when rendering, and when looking up
        // active suggestion.
        const suggestions: Array<Suggestion> = [];
        const headPos = tr.selection.$head.pos;
        newState.doc.descendants((node, pos) => {
          if (node.isText && node.text != null) {
            const text = node.text;
            const matches = text.matchAll(pattern);
            for (const match of matches) {
              const from = pos + match.index;
              const to = from + match[0].length;
              suggestions.push(
                createSuggestion(
                  from,
                  to,
                  isBetweenInclusive(from, to, headPos),
                  match[0],
                ),
              );
            }
          }
        });
        return suggestions;
      },
    },

    props: {
      handleKeyDown(view, event) {
        const active = getActiveSuggestion(this.getState(view.state));
        if (active == null) return false;

        if (event.key === "ArrowDown") {
          const msg = createArrowDownMsg();
          if (debug()) console.debug(source, msg);
          return reducer(view, msg);
        } else if (event.key === "ArrowUp") {
          const msg = createArrowDownMsg();
          if (debug()) console.debug(source, msg);
          return reducer(view, msg);
        } else if (event.key === "Tab") {
          const msg = createTabMsg(active);
          if (debug()) console.debug(source, msg);
          return reducer(view, msg);
        } else if (event.key === "Enter") {
          const msg = createEnterMsg(active);
          if (debug()) console.debug(source, msg);
          return reducer(view, msg);
        }

        return false;
      },

      decorations(state) {
        const suggestions = this.getState(state) ?? [];
        return DecorationSet.create(state.doc, suggestions.map(decoration));
      },
    },
  });
};
