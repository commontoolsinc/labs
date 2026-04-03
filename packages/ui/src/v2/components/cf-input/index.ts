import { CFInput, InputType } from "./cf-input.ts";

if (!customElements.get("cf-input")) {
  customElements.define("cf-input", CFInput);
}

export { CFInput };
export type { InputType };
