import { BadgeVariant, CFBadge } from "./cf-badge.ts";

if (!customElements.get("cf-badge")) {
  customElements.define("cf-badge", CFBadge);
}

export { CFBadge };
export type { BadgeVariant };
