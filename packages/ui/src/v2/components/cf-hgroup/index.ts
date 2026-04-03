import { CFHGroup } from "./cf-hgroup.ts";

if (!customElements.get("cf-hgroup")) {
  customElements.define("cf-hgroup", CFHGroup);
}

export { CFHGroup };
