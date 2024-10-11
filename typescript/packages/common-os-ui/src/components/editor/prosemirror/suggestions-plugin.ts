import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { isBetweenInclusive } from "../../../shared/number.js";
import { Rect } from "../../../shared/position.js";
import { debug } from "../../../shared/debug.js";

const freeze = Object.freeze;

/// Create a frozen suggestion
export const createSuggestion = (
  from: number,
  to: number,
  active: boolean,
  text: string,
) => freeze({ from, to, active, text });

export type Suggestion = ReturnType<typeof createSuggestion>;

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

export const createUpdateMsg = (active: Suggestion, coords: Rect) =>
  freeze({
    active,
    coords,
  });

export type UpdateMsg = ReturnType<typeof createUpdateMsg>;

const noOp = () => {};
const alwaysFalse = () => false;

export const suggestionsPlugin = ({
  pattern,
  decoration,
  onUpdate = noOp,
  onDestroy = noOp,
  onArrowDown = alwaysFalse,
  onArrowUp = alwaysFalse,
  onTab = alwaysFalse,
  onEnter = alwaysFalse,
}: {
  pattern: RegExp;
  decoration: (suggestion: Suggestion) => Decoration;
  onUpdate?: (view: EditorView, update: UpdateMsg | null) => void;
  onDestroy?: (view: EditorView) => void;
  onArrowDown?: (view: EditorView) => boolean;
  onArrowUp?: (view: EditorView) => boolean;
  onTab?: (view: EditorView) => boolean;
  onEnter?: (view: EditorView) => boolean;
}) => {
  const source = "suggestionsPlugin";

  return new Plugin({
    key: new PluginKey("suggestions"),

    view(view: EditorView) {
      return {
        update: (view: EditorView, _prevState: EditorState) => {
          const state = view.state;
          const active = getActiveSuggestion(this.key?.getState(state));
          if (active) {
            const coords = getSuggestionRect(view, active);
            const msg = createUpdateMsg(active, coords);
            if (debug()) console.debug(source, "onUpdate", msg);
            onUpdate(view, msg);
          } else {
            if (debug()) console.debug(source, "onUpdate", null);
            onUpdate(view, null);
          }
        },
        destroy: () => {
          if (debug()) console.debug(source, "onDestroy");
          onDestroy(view);
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
          if (debug()) console.debug(source, "onArrowDown");
          return onArrowDown(view);
        } else if (event.key === "ArrowUp") {
          if (debug()) console.debug(source, "onArrowUp");
          return onArrowUp(view);
        } else if (event.key === "Tab") {
          if (debug()) console.debug(source, "onTab");
          return onTab(view);
        } else if (event.key === "Enter") {
          if (debug()) console.debug(source, "onEnter");
          return onEnter(view);
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
