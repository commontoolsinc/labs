import { CTFab } from "./ct-fab.ts";

if (!customElements.get("ct-fab")) {
  customElements.define("ct-fab", CTFab);
}

export { CTFab };
export type {
  CTFab as CTFabElement,
};
