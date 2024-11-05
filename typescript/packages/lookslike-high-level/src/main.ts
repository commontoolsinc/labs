import "../../common-os-ui/src/static/main.css";
export { components } from "@commontools/common-ui";
export { fab } from "@commontools/common-os-ui";
export { components as myComponents } from "./components.js";
import { setDebug } from "@commontools/common-html";
import "./router.js";

setDebug(!!(import.meta as any).env.VITE_DEBUG);
