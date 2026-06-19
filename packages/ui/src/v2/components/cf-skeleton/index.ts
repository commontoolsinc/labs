import { CFSkeleton } from "./cf-skeleton.ts";

import { SkeletonVariant } from "./cf-skeleton.ts";
import { skeletonStyles } from "./styles.ts";

if (!customElements.get("cf-skeleton")) {
  customElements.define("cf-skeleton", CFSkeleton);
}

export type { CFSkeleton as CFSkeletonElement } from "./cf-skeleton.ts";

export { CFSkeleton, skeletonStyles };
export type { SkeletonVariant };
