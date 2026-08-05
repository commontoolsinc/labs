import { isDeno } from "@commonfabric/utils/env";
import { FS_URL, InnerCache, type StaticCache } from "./cache.ts";

// What a test fetches when it needs an asset and does not care which one. Any
// entry in `assets` serves, under two constraints: `TEST_ASSET_CONTENT` has to
// be a string the chosen file contains, and a test showing that two assets
// differ has to hold this one against a different entry.
export const TEST_ASSET = "types/dom.d.ts";

// A string `TEST_ASSET` contains, for checking that its bytes arrived. It names
// a generated file, so a compiler roll can change the contents and leave this
// needing an update.
export const TEST_ASSET_CONTENT = "interface AddEventListenerOptions";

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
