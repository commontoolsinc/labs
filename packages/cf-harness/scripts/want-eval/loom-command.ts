/**
 * Commands run through the Common Fabric Service with `loom command run`,
 * the way the evals beside this file file wants and read jobs.
 */

/** The owner whose wants the evals file, unless a run names another. */
export const DEFAULT_OWNER =
  "did:key:z6MkmPfWUUyFMehEAjTpYaR1U7MBaNuHnyB3y83DgTkPXJGq";

/** Runs `command` through the service and returns its parsed reply. */
export const loomCommand = async (
  command: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const child = new Deno.Command("loom", {
    args: ["command", "run", "--json", command, "--args-json", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(input)));
  await writer.close();
  const { stdout } = await child.output();
  return JSON.parse(new TextDecoder().decode(stdout));
};
