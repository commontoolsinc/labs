import * as FS from "jsr:@std/fs";
import * as Router from "./router.ts";
import * as Error from "./error.ts";
import type { SystemError, AsyncResult, ConnectionError } from "./interface.ts";
export * from "./interface.ts";

export * as Replica from "./store.ts";

export { Router };

/**
 * Opens a session at specified store location.
 */
export const open = async (
  options: Router.Options,
): AsyncResult<Router.Session, ConnectionError> => {
  try {
    await FS.ensureDir(options.store);
    return await Router.open(options);
  } catch (cause) {
    return { error: Error.connection(options.store, cause as SystemError) };
  }
};
