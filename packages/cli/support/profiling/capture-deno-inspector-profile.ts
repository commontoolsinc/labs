import { Celestial } from "../../../../packages/vendor-astral/bindings/celestial.ts";
import {
  captureDenoInspectorProfile,
  guardCaptureStopSignal,
} from "./capture-deno-inspector-profile-lib.ts";

if (import.meta.main) {
  // captureDenoInspectorProfile removes its own stop-signal handlers as it
  // returns; keep an exit-time guard for the parent's stop signal installed for
  // the whole process so a late stop signal never terminates this one-shot
  // capture with 128+signal after the profile has been written. Ctrl-C (SIGINT)
  // stays unguarded as a manual escape hatch.
  guardCaptureStopSignal(Deno.addSignalListener);
  const exitCode = await captureDenoInspectorProfile(Deno.args, {
    addSignalListener: Deno.addSignalListener,
    createCelestial: (ws) => new Celestial(ws),
    createWebSocket: (url) => new WebSocket(url),
    removeSignalListener: Deno.removeSignalListener,
  });
  Deno.exit(exitCode);
}
