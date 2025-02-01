import * as Path from "@std/path";
export { refer } from "npm:merkle-reference";

/**
 * Returns file URL for the current working directory.
 */
export const baseURL = () => asDirectory(Path.toFileUrl(Deno.cwd()));

export const createTemporaryDirectory = async () =>
  asDirectory(Path.toFileUrl(await Deno.makeTempDir()));

export const asDirectory = (url: URL) => (url.href.endsWith("/") ? url : new URL(`${url.href}/`));
