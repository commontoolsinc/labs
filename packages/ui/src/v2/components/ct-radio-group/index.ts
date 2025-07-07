import { CTRadioGroup } from "./ct-radio-group.ts";
import { radioGroupStyles } from "./styles.ts";

if (!customElements.get("ct-radio-group")) {
  customElements.define("ct-radio-group", CTRadioGroup);
}

export { CTRadioGroup, radioGroupStyles };
