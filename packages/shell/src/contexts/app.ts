import { createContext } from "@lit/context";
import { AppState } from "../models/app.ts";

export const appContext = createContext<AppState>("app");
