/**
 * UI Alert Component Export and Registration
 */

import { AlertVariant, CTAlert } from "./ct-alert.ts";

if (!customElements.get("ct-alert")) {
  customElements.define("ct-alert", CTAlert);
}

export { CTAlert };
export type { AlertVariant };
