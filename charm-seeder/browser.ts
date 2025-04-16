// FIXME(ja): all this should be in the utils module

import { ConsoleEvent, launch } from "@astral/astral";

const HEADLESS = (Deno.env.get("HEADLESS") ?? "true") === "true";
export const browser = await launch({
  args: ["--window-size=1280,1024"],
  headless: HEADLESS,
});
export const page = await browser.newPage();

// export const logs: ConsoleEvent[] = [];

// page.addEventListener("console", (e: ConsoleEvent) => {
//   logs.push(e);
// });

// export const getLogs = () => [...logs];
// export const clearLogs = () => {
//   logs.length = 0;
// };
