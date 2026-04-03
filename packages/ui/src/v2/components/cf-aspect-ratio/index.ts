import { CFAspectRatio } from "./cf-aspect-ratio.ts";
import { aspectRatioStyles } from "./styles.ts";

if (!customElements.get("cf-aspect-ratio")) {
  customElements.define("cf-aspect-ratio", CFAspectRatio);
}

export { CFAspectRatio };
export { aspectRatioStyles };
