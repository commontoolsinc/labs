import { isBrowser, isDeno } from "@commontools/utils/env";
import { decode } from "@commontools/utils/encoding";
// Use `posix` path utils specifically so that the path lib
// does not check `Deno?.build.os` for Windows, which will
// be true in the `deno-web-test` environment as `Deno.test`
// is shimmed, causing a fail to access `os` from `undefined`.
import { toFileUrl } from "@std/path/posix/to-file-url";
import { join } from "@std/path/posix/join";

export const assets = [
  "es2023.d.ts",
];

const DEFAULT_BASE: URL = (() => {
  if (isBrowser()) {
    return new URL(globalThis.location.href);
  } else if (isDeno()) {
    if (!import.meta.dirname) {
      throw new Error("Must be executed from local file.");
    }
    return toFileUrl(join(import.meta.dirname, "static"));
  }
  throw new Error("Unsupported environment.");
})();

export interface GetAssetConfig {
  overrideBase?: string;
}

export async function getAsset(
  assetName: string,
  config?: GetAssetConfig,
): Promise<Uint8Array> {
  if (!assets.includes(assetName)) {
    throw new Error(`No static asset "${assetName}" found.`);
  }
  const url = getAssetUrl(assetName, config);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not retrieve "${assetName}".`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function getAssetText(
  assetName: string,
  config?: GetAssetConfig,
): Promise<string> {
  return decode(await getAsset(assetName, config));
}

export function getAssetUrl(assetName: string, config?: GetAssetConfig): URL {
  if (!assets.includes(assetName)) {
    throw new Error(`No static asset "${assetName}" found.`);
  }
  const url = config?.overrideBase
    ? new URL(config.overrideBase)
    : new URL(DEFAULT_BASE);
  url.pathname = `${url.pathname}/${assetName}`;
  return url;
}
