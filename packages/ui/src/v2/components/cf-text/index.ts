import { CFText } from "./cf-text.ts";

if (!customElements.get("cf-text")) {
  customElements.define("cf-text", CFText);
}

export { CFText };
export type { TextTone, TextVariant } from "./cf-text.ts";
