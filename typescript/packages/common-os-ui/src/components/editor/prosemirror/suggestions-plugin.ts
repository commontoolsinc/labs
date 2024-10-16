import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { isBetweenInclusive } from "../../../shared/number.js";
import { Rect } from "../../../shared/position.js";
import { debug } from "../../../shared/debug.js";
import { TypeMsg, ValueMsg } from "../../../shared/store.js";
import { replaceWithText } from "./utils.js";

const freeze = Object.freeze;

export type Suggestion = ReturnType<typeof createSuggestion>;

/// Create a frozen suggestion
export const createSuggestion = (
  from: number,
  to: number,
  active: boolean,
  text: string,
) => freeze({ from, to, active, text });

export const isSuggestionActive = (suggestion: Suggestion) => suggestion.active;

/** Get the rect representing the suggestion range */
export const getSuggestionRect = (
  view: EditorView,
  suggestion: Suggestion,
): Rect => {
  const fromRect = view.coordsAtPos(suggestion.from);
  const toRect = view.coordsAtPos(suggestion.to);
  return freeze({
    left: fromRect.left,
    right: toRect.right,
    top: toRect.top,
    bottom: toRect.bottom,
  });
};

export const getActiveSuggestion = (
  suggestions: Array<Suggestion> | undefined | null,
): Suggestion | null => suggestions?.find(isSuggestionActive) ?? null;

export type ActiveUpdateMsg = {
  type: "activeUpdate";
  active: Suggestion;
  coords: Rect;
};

export const createActiveUpdateMsg = ({
  active,
  coords,
}: {
  active: Suggestion;
  coords: Rect;
}): ActiveUpdateMsg =>
  freeze({
    type: "activeUpdate",
    active,
    coords,
  });

export type InactiveUpdateMsg = TypeMsg<"inactiveUpdate">;

export const createInactiveUpdateMsg = (): InactiveUpdateMsg =>
  freeze({
    type: "inactiveUpdate",
  });

export type DestroyMsg = TypeMsg<"destroy">;

export const createDestroyMsg = (): DestroyMsg =>
  freeze({
    type: "destroy",
  });

export type ArrowDownMsg = TypeMsg<"arrowDown">;

export const createArrowDownMsg = (): ArrowDownMsg =>
  freeze({
    type: "arrowDown",
  });

export type ArrowUpMsg = TypeMsg<"arrowUp">;

export const createArrowUpMsg = () =>
  freeze({
    type: "arrowUp",
  });

export type EnterMsg = ValueMsg<"enter", Suggestion>;

export const createEnterMsg = (value: Suggestion): EnterMsg =>
  freeze({
    type: "enter",
    value,
  });

export type TabMsg = ValueMsg<"tab", Suggestion>;

export const createTabMsg = (value: Suggestion) =>
  freeze({
    type: "tab",
    value,
  });

export type Msg =
  | ActiveUpdateMsg
  | InactiveUpdateMsg
  | EnterMsg
  | DestroyMsg
  | ArrowDownMsg
  | ArrowUpMsg
  | TabMsg;

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

  const send = (view: EditorView, msg: Msg): boolean => {
    // If debug is on, automatically log everything that passes through reducer.
    if (debug()) console.debug(source, "msg", msg);
    return reducer(view, msg);
  };

  return new Plugin({
    key: new PluginKey("suggestions"),

    view(view: EditorView) {
      return {
        update: (view: EditorView, _prevState: EditorState) => {
          const state = view.state;
          const active = getActiveSuggestion(this.key?.getState(state));
          if (active) {
            const coords = getSuggestionRect(view, active);
            const msg = createActiveUpdateMsg({ active, coords });
            send(view, msg);
          } else {
            const msg = createInactiveUpdateMsg();
            send(view, msg);
          }
        },
        destroy: () => {
          const msg = createDestroyMsg();
          send(view, msg);
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
          return send(view, msg);
        } else if (event.key === "ArrowUp") {
          const msg = createArrowUpMsg();
          return send(view, msg);
        } else if (event.key === "Tab") {
          const msg = createTabMsg(active);
          return send(view, msg);
        } else if (event.key === "Enter") {
          const msg = createEnterMsg(active);
          return send(view, msg);
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

export const replaceSuggestionWithText = (
  suggestion: Suggestion,
  text: string,
) => replaceWithText(suggestion.from, suggestion.to, text);
