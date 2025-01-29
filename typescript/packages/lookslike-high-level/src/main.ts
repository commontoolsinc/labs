import "../../common-os-ui/src/static/main.css";
export { components } from "@commontools/ui";
export { fab } from "@commontools/os-ui";
export { components as myComponents } from "./components.js";
import { setDebug } from "@commontools/html";
import "./router.js";

setDebug(!!(import.meta as any).env.VITE_DEBUG);
