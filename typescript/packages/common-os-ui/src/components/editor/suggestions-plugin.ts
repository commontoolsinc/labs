import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { isBetweenInclusive } from "../../shared/number.js";

export type Suggestion = {
  from: number;
  to: number;
  active: boolean;
  text: string;
};

export const suggestionsPlugin = ({
  pattern,
  decoration,
  onKeyDown,
}: {
  pattern: RegExp;
  decoration: (suggestion: Suggestion) => Decoration;
  onKeyDown: (view: EditorView, event: KeyboardEvent) => boolean;
}) => {
  return new Plugin({
    key: new PluginKey("suggestions"),

    view(_editorView: EditorView) {
      return {
        update(_view: EditorView, _prevState: EditorState) {
          // Update logic can be added here if needed
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
              suggestions.push({
                from,
                to,
                active: isBetweenInclusive(from, to, headPos),
                text: match[0],
              });
            }
          }
        });
        return suggestions;
      },
    },

    props: {
      /**
       * Call the keydown hook if suggestion is active.
       */
      handleKeyDown(view, event) {
        // const state = this.getState(view.state);
        // if (state == null) return;
        // if (!state.active) return false;
        // return onKeyDown(view, event, state);
        return onKeyDown(view, event);
      },

      decorations(state) {
        const suggestions = this.getState(state) ?? [];
        return DecorationSet.create(state.doc, suggestions.map(decoration));
      },
    },
  });
};
