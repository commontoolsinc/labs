import { CTSkeleton, SkeletonVariant } from "./ct-skeleton.ts";
import { skeletonStyles } from "./styles.ts";

if (!customElements.get("ct-skeleton")) {
  customElements.define("ct-skeleton", CTSkeleton);
}

export { CTSkeleton, skeletonStyles };
export type { SkeletonVariant };
