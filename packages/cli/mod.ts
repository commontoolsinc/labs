import { parse } from "./commands/mod.ts";

export async function main(args: string[]) {
  try {
    await parse(args);
    Deno.exit(0);
  } catch (e) {
    console.error(e);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main(Deno.args);
}
