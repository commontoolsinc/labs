import { CFCodeEditor, MimeType } from "./cf-code-editor.ts";

if (!customElements.get("cf-code-editor")) {
  customElements.define("cf-code-editor", CFCodeEditor);
}

export { CFCodeEditor, MimeType };
export type { MimeType as MimeTypeType };
