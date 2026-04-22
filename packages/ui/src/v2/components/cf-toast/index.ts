import { CFToast } from "./cf-toast.ts";
import { CFToastProvider } from "./cf-toast-provider.ts";

if (!customElements.get("cf-toast")) {
  customElements.define("cf-toast", CFToast);
}

if (!customElements.get("cf-toast-provider")) {
  customElements.define("cf-toast-provider", CFToastProvider);
}

export { CFToast, CFToastProvider };
