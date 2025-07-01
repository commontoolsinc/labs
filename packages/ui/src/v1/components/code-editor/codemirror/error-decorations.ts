import { Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  hoverTooltip,
  Tooltip,
} from "@codemirror/view";

export interface CompilationError {
  line: number;
  column: number;
  message: string;
  type: string;
}

const errorUnderlineStyle = Decoration.mark({
  attributes: { class: "cm-error-underline" },
});

const setErrorsEffect = StateEffect.define<CompilationError[]>();

const errorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(errors, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorsEffect)) {
        const decorations: Decoration[] = [];
        for (const error of effect.value) {
          if (error.line && error.column) {
            const line = tr.state.doc.line(error.line);
            if (line) {
              const from = line.from + error.column - 1;
              let to = from;

              // Find the end of the token
              const lineText = line.text;
              const startCol = error.column - 1;
              let endCol = startCol;

              // Skip whitespace and find token boundary
              while (
                endCol < lineText.length &&
                /[a-zA-Z0-9_$]/.test(lineText[endCol])
              ) {
                endCol++;
              }

              // If we didn't find a token, underline at least one character
              if (endCol === startCol) {
                endCol = Math.min(startCol + 1, lineText.length);
              }

              to = line.from + endCol;

              decorations.push(errorUnderlineStyle.range(from, to) as any);
            }
          }
        }
        return Decoration.set(decorations as any, true);
      }
    }
    return errors.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const errorTooltipField = StateField.define<readonly CompilationError[]>({
  create() {
    return [];
  },
  update(errors, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorsEffect)) {
        return effect.value;
      }
    }
    return errors;
  },
});

const errorTooltip = (
  view: EditorView,
  pos: number,
  side: -1 | 1,
): Tooltip | null => {
  const errors = view.state.field(errorTooltipField);

  for (const error of errors) {
    if (error.line && error.column) {
      const line = view.state.doc.line(error.line);
      if (line) {
        const errorPos = line.from + error.column - 1;
        const lineText = line.text;
        const startCol = error.column - 1;
        let endCol = startCol;

        // Find token boundary
        while (
          endCol < lineText.length &&
          /[a-zA-Z0-9_$]/.test(lineText[endCol])
        ) {
          endCol++;
        }

        if (endCol === startCol) {
          endCol = Math.min(startCol + 1, lineText.length);
        }

        const errorEnd = line.from + endCol;

        if (pos >= errorPos && pos <= errorEnd) {
          return {
            pos: errorPos,
            above: true,
            create() {
              const dom = document.createElement("div");
              dom.className = "cm-error-tooltip";
              dom.textContent = `[${error.type}] ${error.message}`;
              return { dom };
            },
          };
        }
      }
    }
  }

  return null;
};

const errorStyles = EditorView.baseTheme({
  ".cm-error-underline": {
    textDecoration: "underline wavy red",
    textUnderlineOffset: "3px",
  },
  ".cm-error-tooltip": {
    backgroundColor: "#1e1e1e",
    color: "#ff6464",
    border: "1px solid #ff6464",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "14px",
    maxWidth: "500px",
    whiteSpace: "pre-wrap",
  },
});

export function setErrors(view: EditorView, errors: CompilationError[]) {
  view.dispatch({
    effects: setErrorsEffect.of(errors),
  });
}

export function errorDecorations(): Extension {
  return [
    errorField,
    errorTooltipField,
    errorStyles,
    hoverTooltip(errorTooltip),
  ];
}
