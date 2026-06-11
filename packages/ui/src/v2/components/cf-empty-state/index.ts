import { CFEmptyState } from "./cf-empty-state.ts";

if (!customElements.get("cf-empty-state")) {
  customElements.define("cf-empty-state", CFEmptyState);
}

export { CFEmptyState };
