import { assets } from "./assets.ts";
import { decode } from "@commonfabric/utils/encoding";
import { isDeno } from "@commonfabric/utils/env";
// Use `posix` path utils specifically so that the path lib
// does not check `Deno?.build.os` for Windows, which will
// be true in the `deno-web-test` environment as `Deno.test`
// is shimmed, causing a fail to access `os` from `undefined`.
import { toFileUrl } from "@std/path/posix/to-file-url";
import { join } from "@std/path/posix/join";
import { generateETag } from "./etag.ts";

const FS_URL = (import.meta.dirname && isDeno())
  ? toFileUrl(join(import.meta.dirname, "assets"))
  : undefined;

/**
 * Represents a cached static asset with its content and ETag.
 */
export interface CachedAsset {
  buffer: Uint8Array;
  etag: string;
}

/**
 * The cache of static assets served from one base location, holding each
 * asset's content together with a strong ETag over that content. An asset is
 * read at most once per instance: under Deno it is read off the file system,
 * and elsewhere it is fetched over the network.
 */
export class StaticCache {
  private cache: Map<string, Promise<CachedAsset>> = new Map();
  private baseUrl: URL;

  /**
   * Constructs an instance which resolves asset names against `baseUrl`.
   */
  constructor(baseUrl: URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Constructs an instance reading the assets bundled alongside this module,
   * which requires the file system and so is available only under Deno.
   */
  static fromFileSystem(): StaticCache {
    if (!FS_URL) {
      throw new Error(
        "`StaticCache.fromFileSystem()` is only available in Deno.",
      );
    }
    return new StaticCache(new URL(FS_URL));
  }

  /**
   * Get the content buffer of a static asset.
   * Backward compatible method that returns only the buffer.
   */
  async get(assetName: string): Promise<Uint8Array> {
    const cached = await this.getWithETag(assetName);
    return cached.buffer;
  }

  /**
   * Get a static asset with its ETag for cache validation.
   * Returns both the content buffer and the generated ETag.
   */
  getWithETag(assetName: string): Promise<CachedAsset> {
    const currentValue = this.cache.get(assetName);
    if (currentValue) {
      return currentValue;
    }
    const promise = this.requestWithETag(assetName);
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

    const url = new URL(this.baseUrl);
    url.pathname = join(url.pathname, assetName);
    return url;
  }

  /**
   * Fetch an asset and generate its ETag.
   * Handles both Deno (file system) and browser (HTTP) environments.
   */
  private async requestWithETag(assetName: string): Promise<CachedAsset> {
    const url = this.getUrl(assetName);
    let buffer: Uint8Array;

    if (isDeno()) {
      // In Deno, use readFile rather than `fetch`, as
      // `fetch` doesn't seem to play well with included assets
      // in "compiled" builds
      buffer = await Deno.readFile(url);
    } else {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Could not retrieve "${assetName}" at "${url.toString()}".`,
        );
      }
      buffer = new Uint8Array(await res.arrayBuffer());
    }

    const etag = await generateETag(buffer);
    return { buffer, etag };
  }
}
