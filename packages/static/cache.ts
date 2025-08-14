import { assets } from "./assets.ts";
import { decode } from "@commontools/utils/encoding";
import { isBrowser, isDeno } from "@commontools/utils/env";
// Use `posix` path utils specifically so that the path lib
// does not check `Deno?.build.os` for Windows, which will
// be true in the `deno-web-test` environment as `Deno.test`
// is shimmed, causing a fail to access `os` from `undefined`.
import { toFileUrl } from "@std/path/posix/to-file-url";
import { join } from "@std/path/posix/join";

const DEFAULT_BASE: URL = (() => {
  // Deno base URL is an absolute path to the `./assets/` directory
  if (isDeno()) {
    if (!import.meta.dirname) {
      throw new Error("Must be executed from local file.");
    }
    return toFileUrl(join(import.meta.dirname, "assets"));
  } // Browser base URL is server root with "static" pathname.
  else if (isBrowser()) {
    const url = new URL(globalThis.location.origin);
    url.pathname = "static";
    return url;
  }
  throw new Error("Unsupported environment.");
})();

export interface StaticCacheConfig {
  baseUrl: URL;
}

export class StaticCache {
  private cache: Map<string, Promise<Uint8Array>> = new Map();
  private config: StaticCacheConfig;
  constructor(config: StaticCacheConfig = {
    baseUrl: new URL(DEFAULT_BASE),
  }) {
    this.config = config;
  }

  get(assetName: string): Promise<Uint8Array> {
    const currentValue = this.cache.get(assetName);
    if (currentValue) {
      return currentValue;
    }
    const promise = this.request(assetName);
    this.cache.set(assetName, promise);
    return promise;
  }

  async getText(assetName: string): Promise<string> {
    return decode(await this.get(assetName));
  }

  getUrl(assetName: string): URL {
    if (!assets.includes(assetName)) {
      throw new Error(`No static asset "${assetName}" found.`);
    }

    const url = this.getBaseUrl();
    url.pathname = join(url.pathname, assetName);
    return url;
  }

  getBaseUrl(): URL {
    return new URL(this.config.baseUrl);
  }

  private async request(assetName: string): Promise<Uint8Array> {
    const url = this.getUrl(assetName);
    if (isDeno()) {
      // In Deno, use readFile rather than `fetch`, as
      // `fetch` doesn't seem to play well with included assets
      // in "compiled" builds
      return Deno.readFile(url);
    } else {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Could not retrieve "${assetName}" at "${url.toString()}".`,
        );
      }
      return new Uint8Array(await res.arrayBuffer());
    }
  }
}
