import { CTTextarea } from "./ct-textarea.ts";

if (!customElements.get("ct-textarea")) {
  customElements.define("ct-textarea", CTTextarea);
}

export { CTTextarea };
