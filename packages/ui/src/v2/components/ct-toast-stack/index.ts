import { CTToastStack } from "./ct-toast-stack.ts";

if (!customElements.get("ct-toast-stack")) {
  customElements.define("ct-toast-stack", CTToastStack);
}

export { CTToastStack };
export type { ToastPosition } from "./ct-toast-stack.ts";
