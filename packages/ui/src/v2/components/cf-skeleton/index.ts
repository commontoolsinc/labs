import { CFSkeleton, SkeletonVariant } from "./cf-skeleton.ts";
import { skeletonStyles } from "./styles.ts";

if (!customElements.get("cf-skeleton")) {
  customElements.define("cf-skeleton", CFSkeleton);
}

export { CFSkeleton, skeletonStyles };
export type { SkeletonVariant };
