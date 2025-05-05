import * as Memory from "@commontools/memory";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";

const result = await Memory.Provider.open({
  store: new URL(env.MEMORY_DIR),
  serviceDid: identity.did(),
});

if (result.error) {
  throw result.error;
}

export const memory = result.ok;
export { Memory };
