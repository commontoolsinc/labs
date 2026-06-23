import { CFCodeEditor } from "./cf-code-editor.ts";

import { MimeType } from "./cf-code-editor.ts";

if (!customElements.get("cf-code-editor")) {
  customElements.define("cf-code-editor", CFCodeEditor);
}

export type { CFCodeEditor as CFCodeEditorElement } from "./cf-code-editor.ts";

export { CFCodeEditor, MimeType };
export type { MimeType as MimeTypeType };
