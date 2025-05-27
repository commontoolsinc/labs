import { StaticCache } from "./cache.ts";
export { assets } from "./assets.ts";

// Global cache for static assets.
const cache = new StaticCache();
export { cache, StaticCache };
