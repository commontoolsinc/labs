import { CTToast } from "./ct-toast.ts";

if (!customElements.get("ct-toast")) {
  customElements.define("ct-toast", CTToast);
}

export { CTToast };
export type { ToastNotification, ToastVariant } from "./ct-toast.ts";
