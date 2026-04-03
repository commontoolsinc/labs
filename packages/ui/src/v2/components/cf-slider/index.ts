import { CFSlider, SliderOrientation } from "./cf-slider.ts";

if (!customElements.get("cf-slider")) {
  customElements.define("cf-slider", CFSlider);
}

export { CFSlider };
export type { SliderOrientation };
