import { CFTextarea } from "./cf-textarea.ts";

if (!customElements.get("cf-textarea")) {
  customElements.define("cf-textarea", CFTextarea);
}

export { CFTextarea };
