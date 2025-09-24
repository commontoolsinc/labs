import { CTListItem } from "./ct-list-item.ts";

if (!customElements.get("ct-list-item")) {
  customElements.define("ct-list-item", CTListItem);
}

export type { CTListItem as CTListItemElement } from "./ct-list-item.ts";
