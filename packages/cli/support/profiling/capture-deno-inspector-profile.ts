import { Celestial } from "../../../../packages/vendor-astral/bindings/celestial.ts";
import { captureDenoInspectorProfile } from "./capture-deno-inspector-profile-lib.ts";

if (import.meta.main) {
  const exitCode = await captureDenoInspectorProfile(Deno.args, {
    addSignalListener: Deno.addSignalListener,
    createCelestial: (ws) => new Celestial(ws),
    createWebSocket: (url) => new WebSocket(url),
    removeSignalListener: Deno.removeSignalListener,
  });
  Deno.exit(exitCode);
}
