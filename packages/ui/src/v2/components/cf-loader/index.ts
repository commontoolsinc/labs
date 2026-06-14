import { CFLoader, LoaderSize } from "./cf-loader.ts";

if (!customElements.get("cf-loader")) {
  customElements.define("cf-loader", CFLoader);
}

export { CFLoader };
export type { LoaderSize };
