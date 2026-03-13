import { CTRouterProvider } from "./ct-router-provider.ts";
import { CTRoute } from "./ct-route.ts";
import { CTLink } from "./ct-link.ts";

if (!customElements.get("ct-router-provider")) {
  customElements.define("ct-router-provider", CTRouterProvider);
}

if (!customElements.get("ct-route")) {
  customElements.define("ct-route", CTRoute);
}

if (!customElements.get("ct-link")) {
  customElements.define("ct-link", CTLink);
}

export { CTLink, CTRoute, CTRouterProvider };
