import { CFAvatar } from "./cf-avatar.ts";

if (!customElements.get("cf-avatar")) {
  customElements.define("cf-avatar", CFAvatar);
}

export { CFAvatar };
export type { AvatarShape, AvatarSize } from "./cf-avatar.ts";
export { initialsForName, isAvatarImageUrl } from "./cf-avatar.ts";
