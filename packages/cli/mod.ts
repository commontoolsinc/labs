import { type Command, CommandType, type RunCommand } from "./interface.ts";
import { RuntimeCLI } from "./cli.ts";
import { Processor } from "./commands/processor.ts";

export { type Command, CommandType, Processor, type RunCommand, RuntimeCLI };

async function main(args: string[]) {
  const cli = new RuntimeCLI();
  const command = await cli.parse(args);
  try {
    const result = await cli.process(command);
    const mainExport = result && "default" in result ? result.default : result;
    if (mainExport !== undefined) {
      try {
        console.log(JSON.stringify(mainExport, null, 2));
      } catch (_e) {
        console.log(mainExport);
      }
    }
    Deno.exit(0);
  } catch (e) {
    console.error(e && typeof e.toString === "function" ? e.toString() : e);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main(Deno.args);
}
