import { CTKeybind } from "./ct-keybind.ts";

if (!customElements.get("ct-keybind")) {
  customElements.define("ct-keybind", CTKeybind);
}

export { CTKeybind };
export type { CTKeybind as CTKeybindElement } from "./ct-keybind.ts";

