/**
 * UI Alert Component Export and Registration
 */

import { AlertVariant, CFAlert } from "./cf-alert.ts";

if (!customElements.get("cf-alert")) {
  customElements.define("cf-alert", CFAlert);
}

export { CFAlert };
export type { AlertVariant };
