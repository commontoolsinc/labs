import { BadgeVariant, CTBadge } from "./ct-badge.ts";

if (!customElements.get("ct-badge")) {
  customElements.define("ct-badge", CTBadge);
}

export { CTBadge };
export type { BadgeVariant };
