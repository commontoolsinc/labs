import { CFProfileBadge } from "./cf-profile-badge.ts";

if (!customElements.get("cf-profile-badge")) {
  customElements.define("cf-profile-badge", CFProfileBadge);
}

export { CFProfileBadge };
export type {
  ProfileBadgeDisplay,
  ProfileBadgeState,
} from "./cf-profile-badge.ts";
export { profileDisplayFromValue } from "./cf-profile-badge.ts";
