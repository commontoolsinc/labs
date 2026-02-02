/**
 * CFC Shell Commands - Module exports
 */

// Core types and context
export * from "./context.ts";
export { CommandRegistry } from "./registry.ts";

// Command implementations
import { cd, ls, pwd } from "./navigation.ts";
import { cat, diff, head, tail, wc } from "./read.ts";
import { grep } from "./search.ts";
import { base64, cut, jq, sed, sort, tr, uniq } from "./transform.ts";
import { chmod, cp, mkdir, mv, rm, tee, touch } from "./write.ts";
import { echo, printf } from "./output.ts";
import { env, exportCmd, printenv, unset } from "./env.ts";
import { curl } from "./network.ts";
import { bash, evalCmd, source } from "./exec.ts";
import {
  date,
  falseCmd,
  read,
  sleep,
  test,
  trueCmd,
  which,
  xargs,
} from "./misc.ts";
import { realCommand } from "./real.ts";
import { CommandRegistry } from "./registry.ts";

/**
 * Create a command registry with all built-in commands registered
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  // Navigation
  registry.register("cd", cd);
  registry.register("pwd", pwd);
  registry.register("ls", ls);

  // Read
  registry.register("cat", cat);
  registry.register("head", head);
  registry.register("tail", tail);
  registry.register("wc", wc);
  registry.register("diff", diff);

  // Search
  registry.register("grep", grep);

  // Transform
  registry.register("sed", sed);
  registry.register("sort", sort);
  registry.register("uniq", uniq);
  registry.register("cut", cut);
  registry.register("tr", tr);
  registry.register("jq", jq);
  registry.register("base64", base64);

  // Write
  registry.register("cp", cp);
  registry.register("mv", mv);
  registry.register("rm", rm);
  registry.register("mkdir", mkdir);
  registry.register("touch", touch);
  registry.register("tee", tee);
  registry.register("chmod", chmod);

  // Output
  registry.register("echo", echo);
  registry.register("printf", printf);

  // Environment
  registry.register("export", exportCmd);
  registry.register("unset", unset);
  registry.register("env", env);
  registry.register("printenv", printenv);

  // Network
  registry.register("curl", curl);

  // Exec
  registry.register("bash", bash);
  registry.register("eval", evalCmd);
  registry.register("source", source);

  // Misc
  registry.register("date", date);
  registry.register("true", trueCmd);
  registry.register("false", falseCmd);
  registry.register("test", test);
  registry.register("[", test); // [ is an alias for test
  registry.register("sleep", sleep);
  registry.register("read", read);
  registry.register("which", which);
  registry.register("xargs", xargs);

  // Sandbox
  registry.register("!real", realCommand);

  return registry;
}
