import { LitElement, html, css, PropertyValues } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Schema, DOMParser, DOMSerializer } from "prosemirror-model";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { effect } from "@vue/reactivity";
import { appDocument } from "../components/com-app.js";

const mySchema = new Schema({
  nodes: {
    text: {},
    step: {
      content: "text*",
      toDOM() {
        return ["step", 0];
      },
      parseDOM: [{ tag: "step" }]
    },
    identifier: {
      content: "text*",
      toDOM() {
        return ["identifier", 0];
      },
      parseDOM: [{ tag: "identifier" }]
    },
    connection: {
      content: "text*",
      toDOM() {
        return ["connection", 0];
      },
      parseDOM: [{ tag: "connection" }]
    },
    doc: {
      content: `(step | identifier | connection)+`
    }
  }
});

@customElement("com-document-editor")
export class ComDocumentEditor extends LitElement {
  @query("#editor")
  private editorElement!: HTMLElement;

  private editorView?: EditorView;

  @property({ type: String })
  content: string = ``;

  static override styles = [
    css`
      :host {
        display: block;
        border: 1px solid #ccc;
        padding: 10px;
      }
      .ProseMirror {
        height: 100%;
        overflow-y: auto;
      }

      .ProseMirror p {
        margin: 0;
      }
    `,
    css`
      prompt {
        display: block;
        padding: 3px 6px;
        margin: 5px 0;
        font-family: serif;
        font-weight: bold;
      }

      step,
      identifier,
      connection {
        display: block;
        padding: 3px 6px;
        margin: 5px 0;
        font-family: serif;
      }

      identifier,
      connection {
        font-family: monospace;
        margin-left: 20px;
        font-size: 0.9em;
      }

      doc-embed {
        display: inline-block;
        width: 100px;
        height: 100px;
        background-color: #f9f9f9;
      }
    `,
    css`
      .ProseMirror {
        position: relative;
      }

      .ProseMirror {
        word-wrap: break-word;
        white-space: pre-wrap;
        white-space: break-spaces;
        -webkit-font-variant-ligatures: none;
        font-variant-ligatures: none;
        font-feature-settings: "liga" 0; /* the above doesn't seem to work in Edge */
      }

      .ProseMirror pre {
        white-space: pre-wrap;
      }

      .ProseMirror li {
        position: relative;
      }

      .ProseMirror-hideselection *::selection {
        background: transparent;
      }
      .ProseMirror-hideselection *::-moz-selection {
        background: transparent;
      }
      .ProseMirror-hideselection {
        caret-color: transparent;
      }

      /* See https://github.com/ProseMirror/prosemirror/issues/1421#issuecomment-1759320191 */
      .ProseMirror [draggable][contenteditable="false"] {
        user-select: text;
      }

      .ProseMirror-selectednode {
        outline: 2px solid #8cf;
      }

      /* Make sure li selections wrap around markers */

      li.ProseMirror-selectednode {
        outline: none;
      }

      li.ProseMirror-selectednode:after {
        content: "";
        position: absolute;
        left: -32px;
        right: -2px;
        top: -2px;
        bottom: -2px;
        border: 2px solid #8cf;
        pointer-events: none;
      }

      /* Protect against generic img rules */

      img.ProseMirror-separator {
        display: inline !important;
        border: none !important;
        margin: 0 !important;
      }
    `
  ];

  protected override firstUpdated(changedProperties: PropertyValues): void {
    super.firstUpdated(changedProperties);
    this.initializeProseMirror();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    effect(() => {
      this.content = appDocument.content;
      this.updateContent(appDocument.content);
    });
  }

  private initializeProseMirror() {
    const state = EditorState.create({
      doc: DOMParser.fromSchema(mySchema).parse(this.createContentElement()),
      plugins: [keymap(baseKeymap)]
    });

    this.editorView = new EditorView(this.editorElement, {
      state,
      dispatchTransaction: (transaction) => {
        const newState = this.editorView!.state.apply(transaction);
        this.editorView!.updateState(newState);
        this.handleDocumentChange(newState);
      }
    });
  }

  private createContentElement(): HTMLElement {
    const div = document.createElement("div");
    div.innerHTML = this.content;
    return div;
  }

  private handleDocumentChange(state: EditorState) {
    const content = DOMSerializer.fromSchema(mySchema).serializeFragment(
      state.doc.content
    );

    console.log("doc changed", content);

    if (content instanceof HTMLElement) {
      console.log("updating text content");
      appDocument.content = content.innerHTML;
    } else if (content instanceof DocumentFragment) {
      const textVersion = Array.from(content.children)
        .map((child) => child.outerHTML)
        .join("\n");
      appDocument.content = textVersion;
      console.log("updating text content", textVersion);
    }

    this.dispatchEvent(
      new CustomEvent("document-change", { detail: { content } })
    );
  }

  // Public method to update content
  updateContent(newContent: string) {
    if (this.editorView && !this.editorView.hasFocus()) {
      const { state } = this.editorView;
      const { tr } = state;
      const doc = DOMParser.fromSchema(state.schema).parse(
        this.createContentElement()
      );
      tr.replaceWith(0, state.doc.content.size, doc);
      this.editorView.dispatch(tr);
    }
  }

  // Public method to execute a command
  executeCommand(
    command: (state: EditorState, dispatch: EditorView["dispatch"]) => boolean
  ) {
    if (this.editorView) {
      command(this.editorView.state, this.editorView.dispatch);
    }
  }

  override render() {
    return html`<div id="editor"></div>`;
  }
}
