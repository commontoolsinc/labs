import { CFProgress } from "./cf-progress.ts";

if (!customElements.get("cf-progress")) {
  customElements.define("cf-progress", CFProgress);
}

export { CFProgress };
export type { CFProgress as CFProgressElement };
