import { createContext } from "@lit/context";
import { AppState } from "../lib/app/mod.ts";

export const appContext = createContext<AppState>("app");
