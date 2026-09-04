/**
 * The browser a caller drives: how it is spawned, and how it is stopped in a
 * way the caller can wait out.
 *
 * Chrome recreates the directory `--user-data-dir` names, every missing parent
 * included, whenever it writes into it, and the crash handler and rendering
 * processes it starts outlive the browser process. Removing the profile
 * directory while one of those is alive puts the directory back, so the
 * removal has to follow the last process in the tree, and
 * `Deno.ChildProcess.status` covers one process.
 *
 * Every process in the tree inherits the two pipes the browser was spawned
 * with, and holds a pipe until it exits or closes that pipe. Both read ends
 * are waited for, so the wait ends once the last process holding either of
 * them has gone. Piping both also keeps the browser's output out of the
 * caller's own, which a spawn leaves inherited for any stream it asks no pipe
 * for. The browser is spawned here and astral attached to the running browser,
 * which is what keeps those pipes in reach.
 */

import {
  Browser as AstralBrowser,
  connect,
  generateBinArgs,
  getBinary,
  type LaunchOptions,
  type Page,
  type SandboxOptions,
  type UserAgentOptions,
  type WaitForOptions,
  WEBSOCKET_ENDPOINT_REGEX,
  websocketReady,
} from "@astral/astral";

import { isChildProcessGone } from "./astral-adapter.ts";

/**
 * The message a launch throws when the browser exited without naming an
 * endpoint. Exported so that whoever decides what to do about such a launch
 * names the same string the throw does.
 */
export const BOOT_FAILURE_MESSAGE = "Your binary refused to boot";

/** A browser that has started, and how to reach and wait out its tree. */
type SpawnedBrowser = {
  /** The browser process. */
  child: Deno.ChildProcess;

  /** Host and port of the browser's developer-tools endpoint. */
  endpoint: string;

  /** Resolves once every write end of the browser's output is closed. */
  outputClosed: Promise<void>;
};

/**
 * Resolves once every write end of `stream` is closed, discarding everything
 * read from it.
 *
 * A process that inherits a pipe holds its write end open until it exits or
 * closes the descriptor, and a browser closes neither, so for a browser and
 * everything it starts this is the point at which the last of them has gone.
 * What is read is discarded rather than left unread because a full pipe blocks
 * the process writing into it.
 */
export async function readToEnd(
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  for await (const _chunk of stream) {
    // The bytes say nothing the run acts on; the end of them says everything.
  }
}

/**
 * Kills `child` and returns once every process in its tree has exited.
 *
 * `closed` is what `readBrowserOutput()` reported for the same child. A
 * browser asked to close over the protocol is usually still shutting down when
 * the kill lands, and is occasionally gone already, which throws rather than
 * doing nothing.
 */
export async function stopBrowserProcess(
  child: Pick<Deno.ChildProcess, "kill" | "status">,
  closed: Promise<void>,
): Promise<void> {
  try {
    child.kill();
  } catch (error) {
    if (!isChildProcessGone(error)) {
      throw error;
    }
  }
  await closed;
  await child.status;
}

/**
 * Reads the browser's standard output and standard error to the end of both,
 * and reports the developer-tools endpoint named in the latter.
 *
 * The endpoint is reported while the reads carry on, because the pipes are
 * what say when the browser's processes have gone and a pipe nobody reads
 * fills up and stops the process writing into it. Output that ends without
 * naming an endpoint is a browser that never started: it is written out, and
 * the endpoint fails.
 */
function readBrowserOutput(
  child: Deno.ChildProcess,
): { endpoint: Promise<string>; closed: Promise<void> } {
  const endpoint = Promise.withResolvers<string>();
  const decoder = new TextDecoder();
  let printed = "";
  let named = false;

  const readStandardError = (async () => {
    for await (const chunk of child.stderr) {
      if (named) {
        continue;
      }
      printed += decoder.decode(chunk, { stream: true });
      const found = printed.match(WEBSOCKET_ENDPOINT_REGEX)?.[1];
      if (found) {
        named = true;
        endpoint.resolve(found);
      }
    }
    if (!named) {
      // `isRetryableAstralLaunchError()` matches the message below exactly to
      // decide whether the launch is worth another attempt, so what the
      // browser printed is written out here rather than carried in the error.
      const { code } = await child.status;
      console.error(`${printed}\nProcess exited with code ${code}`);
      endpoint.reject(
        new Error(
          printed.includes("error while loading shared libraries")
            ? `${BOOT_FAILURE_MESSAGE} due to missing system dependencies`
            : BOOT_FAILURE_MESSAGE,
        ),
      );
    }
  })();

  const closed = Promise.all([readStandardError, readToEnd(child.stdout)])
    .then(() => {});
  // The reads run alongside the tests and are awaited when the browser is
  // closed. A rejection nothing is listening for in between ends the process
  // where it stands, so this handler is what marks it listened for; `closed`
  // still carries the failure to whoever awaits it.
  closed.catch(() => {});

  return { endpoint: endpoint.promise, closed };
}

/**
 * Spawns the browser `options` names and returns once it has named its
 * developer-tools endpoint, with its output still being read.
 */
async function spawnBrowser(options: LaunchOptions): Promise<SpawnedBrowser> {
  const product = options.product ?? "chrome";
  const binary = options.path ??
    await getBinary(product, { cache: options.cache });
  const args = generateBinArgs(product, {
    launchPresets: options.launchPresets,
    args: options.args,
    headless: options.headless,
  });

  // The profile directory belongs to whoever launched the browser, and goes
  // when they are done with it. A launch naming none would reach the profile
  // of the browser the developer uses, and write into the directory that
  // profile lives in.
  if (!args.some((argument) => argument.startsWith("--user-data-dir="))) {
    throw new Error("A browser launch has to name a `--user-data-dir`.");
  }

  const child = new Deno.Command(binary, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const { endpoint, closed } = readBrowserOutput(child);
  try {
    return { child, endpoint: await endpoint, outputClosed: closed };
  } catch (error) {
    await stopBrowserProcess(child, closed);
    throw error;
  }
}

/**
 * Connects astral to the browser listening at `endpoint`, running in `child`.
 *
 * Astral's `connect()` hands back a browser holding no process, which reports
 * itself remote, and closing a remote browser's page closes only that page's
 * connection: the target stays open and goes on running, and the pages that
 * are still open grow slow. So the connection `connect()` makes is used for
 * the check it carries -- that the browser speaks the protocol version
 * astral's bindings were generated against -- and then dropped, and the
 * browser handed back is built on a connection of its own, holding the
 * process.
 *
 * That check is what takes two connections: astral holds the protocol version
 * in a binding it does not export, so `connect()` is the only way to ask for
 * it. One connection does when astral exports the version.
 */
async function connectToBrowser(
  child: Deno.ChildProcess,
  endpoint: string,
  options: LaunchOptions,
): Promise<AstralBrowser> {
  const product = options.product ?? "chrome";
  const userAgent = options.userAgent;

  const checked = await connect({ endpoint, product, userAgent });
  const socketUrl = checked.wsEndpoint();
  await checked.disconnect();

  const socket = new WebSocket(socketUrl);
  await websocketReady(socket);
  return new AstralBrowser(socket, child, {
    product,
    userAgent,
    headless: options.headless,
  });
}

/** A running browser, and the process tree the run can wait out. */
export class BrowserProcess {
  #child: Deno.ChildProcess;
  #outputClosed: Promise<void>;
  #browser: AstralBrowser;

  /**
   * Takes the browser process, the promise that resolves once its output has
   * ended, and astral's connection to it. `start()` is what supplies the three
   * of them.
   */
  constructor(
    child: Deno.ChildProcess,
    outputClosed: Promise<void>,
    browser: AstralBrowser,
  ) {
    this.#child = child;
    this.#outputClosed = outputClosed;
    this.#browser = browser;
  }

  /** Opens a page, on `url` where one is given. */
  newPage(
    url?: string,
    options?: WaitForOptions & SandboxOptions & UserAgentOptions,
  ): Promise<Page> {
    return this.#browser.newPage(url, options);
  }

  /**
   * The browser-level developer-tools websocket endpoint. Chrome takes several
   * connections at once, so a second one can attach alongside astral's.
   */
  wsEndpoint(): string {
    return this.#browser.wsEndpoint();
  }

  /**
   * Closes the browser and returns once every process holding the browser's
   * output has closed it, which is once the last of them has exited.
   *
   * The browser is stopped by the signal rather than by astral's `close()`,
   * which asks over the browser's connection and waits for an answer. A
   * browser that has already gone takes that connection with it, and the wait
   * then has nothing to resolve it.
   */
  async close(): Promise<void> {
    try {
      await stopBrowserProcess(this.#child, this.#outputClosed);
    } finally {
      await this.#browser.disconnect();
    }
  }

  /**
   * Spawns the browser `options` names and connects astral to it. A browser
   * that starts and then fails to connect is stopped before this throws.
   */
  static async start(options: LaunchOptions): Promise<BrowserProcess> {
    const spawned = await spawnBrowser(options);
    try {
      const browser = await connectToBrowser(
        spawned.child,
        spawned.endpoint,
        options,
      );
      return new BrowserProcess(
        spawned.child,
        spawned.outputClosed,
        browser,
      );
    } catch (error) {
      await stopBrowserProcess(spawned.child, spawned.outputClosed);
      throw error;
    }
  }
}
