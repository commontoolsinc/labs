import { CTCodeEditor, MimeType } from "./ct-code-editor.ts";

if (!customElements.get("ct-code-editor")) {
  customElements.define("ct-code-editor", CTCodeEditor);
}

export { CTCodeEditor, MimeType };
export type { MimeType as MimeTypeType };

