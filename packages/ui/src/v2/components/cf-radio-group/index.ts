import { CFRadioGroup } from "./cf-radio-group.ts";
import { radioGroupStyles } from "./styles.ts";

if (!customElements.get("cf-radio-group")) {
  customElements.define("cf-radio-group", CFRadioGroup);
}

export { CFRadioGroup, radioGroupStyles };
export type { RadioGroupOrientation, RadioItem } from "./cf-radio-group.ts";
