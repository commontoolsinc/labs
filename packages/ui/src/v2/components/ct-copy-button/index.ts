import { CTCopyButton } from "./ct-copy-button.ts";

if (!customElements.get("ct-copy-button")) {
  customElements.define("ct-copy-button", CTCopyButton);
}

export { CTCopyButton };
