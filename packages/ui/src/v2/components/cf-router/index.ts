import { CFRouter } from "./cf-router.ts";
import { CFLink } from "./cf-link.ts";

if (!customElements.get("cf-router")) {
  customElements.define("cf-router", CFRouter);
}

if (!customElements.get("cf-link")) {
  customElements.define("cf-link", CFLink);
}

export { CFLink, CFRouter };
