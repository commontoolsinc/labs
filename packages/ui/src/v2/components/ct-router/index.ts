import { CTRouter } from "./ct-router.ts";
import { CTLink } from "./ct-link.ts";

if (!customElements.get("ct-router")) {
  customElements.define("ct-router", CTRouter);
}

if (!customElements.get("ct-link")) {
  customElements.define("ct-link", CTLink);
}

export { CTLink, CTRouter };
