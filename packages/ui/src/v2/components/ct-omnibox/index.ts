import { CTOmnibox } from "./ct-omnibox.ts";

if (!customElements.get("ct-omnibox")) {
  customElements.define("ct-omnibox", CTOmnibox);
}

export { CTOmnibox };
export type {
  CTOmnibox as CTOmniboxElement,
};
