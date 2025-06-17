import { CTResizableHandle } from "./ct-resizable-handle.ts";
import { resizableHandleStyles } from "./styles.ts";

if (!customElements.get("ct-resizable-handle")) {
  customElements.define("ct-resizable-handle", CTResizableHandle);
}

export { CTResizableHandle, resizableHandleStyles };
