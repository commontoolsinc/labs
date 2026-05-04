/**
 * UI Alert Component Export and Registration
 */

import { CFAlert } from "./cf-alert.ts";
import type { StatusIntent } from "../theme-context.ts";

if (!customElements.get("cf-alert")) {
  customElements.define("cf-alert", CFAlert);
}

export { CFAlert };
export type { StatusIntent };
