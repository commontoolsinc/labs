import { isDeno } from "@commontools/utils/env";
import { FS_URL, InnerCache, type StaticCache } from "./cache.ts";

// `TestStaticCache` uses StaticCacheFS in Deno and `${window.location.origin}/static`
// in non-Deno, used for tests that run via deno-web-test that target both environments.
export class TestStaticCache extends InnerCache implements StaticCache {
  constructor() {
    let url;
    if (isDeno()) {
      if (!FS_URL) {
        throw new Error("Could not create static cache in Deno.");
      }
      url = new URL(FS_URL);
    } else {
      url = new URL(globalThis.location.origin);
      url.pathname = "static";
    }
    super(url);
  }
}
