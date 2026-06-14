import { CFSeparator, SeparatorOrientation } from "./cf-separator.ts";

if (!customElements.get("cf-separator")) {
  customElements.define("cf-separator", CFSeparator);
}

export { CFSeparator };
export type { SeparatorOrientation };
