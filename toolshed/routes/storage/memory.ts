import * as Memory from "@commontools/memory";
import env from "@/env.ts";

const result = await Memory.Provider.open({
  store: new URL(env.MEMORY_URL),
});

if (result.error) {
  throw result.error;
}

export const memory = result.ok;
export { Memory };
