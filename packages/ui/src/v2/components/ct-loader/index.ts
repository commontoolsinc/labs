import { CTLoader, LoaderSize } from "./ct-loader.ts";

if (!customElements.get("ct-loader")) {
  customElements.define("ct-loader", CTLoader);
}

export { CTLoader };
export type { LoaderSize };
