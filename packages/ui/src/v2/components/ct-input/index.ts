import { CTInput, InputType } from "./ct-input.ts";

if (!customElements.get("ct-input")) {
  customElements.define("ct-input", CTInput);
}

export { CTInput };
export type { InputType };
