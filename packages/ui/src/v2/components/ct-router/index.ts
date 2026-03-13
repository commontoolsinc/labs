import { CTRouterProvider } from "./ct-router-provider.ts";
import { CTRoute } from "./ct-route.ts";

if (!customElements.get("ct-router-provider")) {
  customElements.define("ct-router-provider", CTRouterProvider);
}

if (!customElements.get("ct-route")) {
  customElements.define("ct-route", CTRoute);
}

export { CTRoute, CTRouterProvider };
