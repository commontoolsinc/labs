import * as Memory from "@commontools/memory";
import env from "@/env.ts";

const result = await Memory.Provider.open({
  store: new URL(env.MEMORY_URL),
  rateLimiting: {
    baseThreshold: env.RATELIMIT_BASE_THRESHOLD,
    requestLimit: env.RATELIMIT_REQUEST_LIMIT,
    backoffFactor: env.RATELIMIT_BACKOFF_FACTOR,
    maxDebounceCount: env.MAX_DEBOUNCE_COUNT,
  },
});

if (result.error) {
  throw result.error;
}

export const memory = result.ok;
export { Memory };
