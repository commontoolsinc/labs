import { createContext } from "@lit/context";
import { App } from "../models/app.ts";

export const appContext = createContext<App>("app");
