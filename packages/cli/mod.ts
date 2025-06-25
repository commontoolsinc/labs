import { parse } from "./commands/mod.ts";

export async function main(args: string[]) {
  // Harness handling in lib/handler.ts
  await parse(args);
}

if (import.meta.main) {
  main(Deno.args);
}
