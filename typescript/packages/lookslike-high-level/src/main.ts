import "../../common-os-ui/src/static/main.css";
export { components } from "@commontools/common-ui";
export { fab } from "@commontools/common-os-ui";
export { components as myComponents } from "./components.js";
import { setDebug } from "@commontools/common-html";
import "./router.js";
import './gmail.js'

setDebug(!!(import.meta as any).env.VITE_DEBUG);

// src/main.js or src/main.ts
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(
    new URL("./synopsys.worker.ts", import.meta.url),
    {
      type: "module",
      scope: "/data/",
    },
  );
}
