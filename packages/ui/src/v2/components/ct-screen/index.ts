import { CTScreen } from "./ct-screen.ts";

if (!customElements.get("ct-screen")) {
  customElements.define("ct-screen", CTScreen);
}

export { CTScreen };