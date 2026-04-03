import { CTSlider, SliderOrientation } from "./ct-slider.ts";

if (!customElements.get("ct-slider")) {
  customElements.define("ct-slider", CTSlider);
}

export { CTSlider };
export type { SliderOrientation };
