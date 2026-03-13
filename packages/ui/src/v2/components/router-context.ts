import { createContext } from "@lit/context";

export interface RouterStore {
  url: string;
  setUrl: (url: string) => void;
}

export const routerStoreContext = createContext<RouterStore>("router-store");
