import { type Command, CommandType, type RunCommand } from "./interface.ts";
import { RuntimeCLI } from "./cli.ts";
import { Processor } from "./processor.ts";

export { type Command, CommandType, Processor, type RunCommand, RuntimeCLI };

async function main(args: string[]) {
  const cli = new RuntimeCLI();
  const command = await cli.parse(args);
  try {
    const result = await cli.process(command);
    console.log("default" in result ? result.default : result);
    Deno.exit(0);
  } catch (e) {
    console.error(e && typeof e.toString === "function" ? e.toString() : e);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main(Deno.args);
}
