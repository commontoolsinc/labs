import { CTToolbar } from "./ct-toolbar.ts";

if (!customElements.get("ct-toolbar")) {
  customElements.define("ct-toolbar", CTToolbar);
}

export type { CTToolbar as CTToolbarElement } from "./ct-toolbar.ts";
