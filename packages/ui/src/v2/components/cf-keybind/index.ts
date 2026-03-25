import { CFKeybind } from "./cf-keybind.ts";

if (!customElements.get("cf-keybind")) {
  customElements.define("cf-keybind", CFKeybind);
}

export { CFKeybind };
export type { CFKeybind as CFKeybindElement } from "./cf-keybind.ts";
