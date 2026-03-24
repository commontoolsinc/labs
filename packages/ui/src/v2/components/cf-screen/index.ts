import { CFScreen } from "./cf-screen.ts";

if (!customElements.get("cf-screen")) {
  customElements.define("cf-screen", CFScreen);
}

export { CFScreen };
