import { CTProgress } from "./ct-progress.ts";

if (!customElements.get("ct-progress")) {
  customElements.define("ct-progress", CTProgress);
}

export { CTProgress };
export type { CTProgress as CTProgressElement };
