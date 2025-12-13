import { CTRichtextEditor } from "./ct-richtext-editor.ts";

if (!customElements.get("ct-richtext-editor")) {
  customElements.define("ct-richtext-editor", CTRichtextEditor);
}

export { CTRichtextEditor };
