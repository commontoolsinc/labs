/**
 * The runtime table `docker info` reports, or the reason it could not be read.
 * The running daemon's table rather than `daemon.json`: a configuration file
 * the daemon has not reloaded names directories nothing writes.
 */
export const readDockerRuntimes = async (
  dockerBinary: string,
): Promise<{ runtimes?: unknown; unreadable?: string }> => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(dockerBinary, {
      args: ["info", "--format", "{{json .Runtimes}}"],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    return {
      unreadable: `\`${dockerBinary} info\` could not be run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!output.success) {
    return {
      unreadable: `\`${dockerBinary} info\` exited ${output.code}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    };
  }
  try {
    return { runtimes: JSON.parse(new TextDecoder().decode(output.stdout)) };
  } catch (error) {
    return {
      unreadable: `\`${dockerBinary} info\` reported a runtime table that ` +
        `does not parse: ${
          error instanceof Error ? error.message : String(error)
        }`,
    };
  }
};
