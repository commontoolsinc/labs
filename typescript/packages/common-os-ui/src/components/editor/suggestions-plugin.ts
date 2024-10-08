import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { isBetweenInclusive } from "../../shared/number.js";

export type Suggestion = {
  from: number;
  to: number;
  active: boolean;
  text: string;
};

export const isSuggestionActive = (suggestion: Suggestion) => suggestion.active;

/// Create a frozen suggestion
export const createSuggestion = (
  from: number,
  to: number,
  active: boolean,
  text: string,
): Suggestion => Object.freeze({ from, to, active, text });

export const suggestionsPlugin = ({
  pattern,
  decoration,
  onUpdate,
}: {
  pattern: RegExp;
  decoration: (suggestion: Suggestion) => Decoration;
  onUpdate: (view: EditorView, suggestion: Suggestion | null) => void;
}) => {
  return new Plugin({
    key: new PluginKey("suggestions"),

    view(_view: EditorView) {
      return {
        update: (view: EditorView, _prevState: EditorState) => {
          const state = view.state;
          const suggestions: Array<Suggestion> =
            this.key!.getState(state) ?? [];
          const active = suggestions.find(isSuggestionActive) ?? null;
          onUpdate(view, active);
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
      decorations(state) {
        const suggestions = this.getState(state) ?? [];
        return DecorationSet.create(state.doc, suggestions.map(decoration));
      },
    },
  });
};
