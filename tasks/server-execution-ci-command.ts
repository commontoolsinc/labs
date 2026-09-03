// deno-coverage-ignore-file -- trivial command-line adapter; the command is tested through its library entrypoint.

import { runServerExecutionCiCommand } from "./server-execution-ci.ts";

await runServerExecutionCiCommand(Deno.args);
