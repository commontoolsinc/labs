import { CFFab } from "./cf-fab.ts";

if (!customElements.get("cf-fab")) {
  customElements.define("cf-fab", CFFab);
}

export { CFFab };
export type { CFFab as CFFabElement };
