/**
 * The runner's local job API, reached over its Unix socket the way the Common
 * Fabric Service reaches it: `<instance>/agent-runner/jobs.sock`, every
 * request carrying the bearer token kept beside the socket. The shape eval
 * submits jobs through it, and the wants loop reads the jobs the service
 * started.
 */

import { type IncomingMessage, request } from "@node/http";
import { join } from "@std/path";

/** The socket of the runner an instance at `instanceDir` serves jobs on. */
export const runnerSocketOf = (instanceDir: string): string =>
  join(instanceDir, "agent-runner", "jobs.sock");

/** One request to the runner at `socket`, answered with its whole body. */
export const runnerCall = async (
  socket: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> => {
  const token = (await Deno.readTextFile(`${socket}.token`)).trim();
  return await new Promise((resolve, reject) => {
    const req = request({
      socketPath: socket,
      method,
      path,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    }, (response: IncomingMessage) => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", (chunk: string) => text += chunk);
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
};

/** A job the runner at `socket` holds, as its snapshot. */
export const runnerJobOf = async (
  socket: string,
  id: string,
): Promise<Record<string, unknown>> => {
  const { status, text } = await runnerCall(socket, "GET", `/jobs/${id}`);
  if (status !== 200) throw new Error(`job ${id}: HTTP ${status} ${text}`);
  return JSON.parse(text).job;
};

/**
 * Resolves once the job has ended: its event stream, read from the start,
 * which the runner closes after the job's terminal state.
 */
export const runnerJobEnded = async (
  socket: string,
  id: string,
): Promise<void> => {
  const { status, text } = await runnerCall(
    socket,
    "GET",
    `/jobs/${id}/events?after=0`,
  );
  if (status !== 200) {
    throw new Error(`job ${id} events: HTTP ${status} ${text}`);
  }
};
