import { CTAspectRatio } from "./ct-aspect-ratio.ts";
import { aspectRatioStyles } from "./styles.ts";

if (!customElements.get("ct-aspect-ratio")) {
  customElements.define("ct-aspect-ratio", CTAspectRatio);
}

export { CTAspectRatio };
export { aspectRatioStyles };
