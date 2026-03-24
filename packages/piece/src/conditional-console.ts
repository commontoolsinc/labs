import { Console } from "@commonfabric/runner";
import { isDeno } from "@commonfabric/utils/env";

// "@commonfabric/piece" logs status to console during activity.
// When running in a Deno service or CLI, the logs are cluttering and
// prevent piping data.
//
// In lieu of removing all logging here, use a console shim only when
// running in Deno.
export const console = isDeno() ? new Console() : globalThis.console;
