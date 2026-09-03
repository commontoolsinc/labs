/**
 * The browser a run drives: how it is spawned, and how it is stopped in a way
 * the run can wait out.
 *
 * Chrome recreates the directory `--user-data-dir` names, every missing parent
 * included, whenever it writes into it, and the crash handler and rendering
 * processes it starts outlive the browser process. Removing the run's
 * directory while one of those is alive puts the directory back, so the
 * removal has to follow the last process in the tree, and
 * `Deno.ChildProcess.status` covers one process.
 *
 * Every process in the tree inherits the standard error the browser was
 * spawned with, so the read end of that pipe reports end of file once the last
 * of them has exited. The browser is spawned here and astral attached to the
 * running browser with `connect()`, which is what keeps that pipe in reach.
 */

import {
  type Browser as AstralBrowser,
  connect,
  generateBinArgs,
  getBinary,
  type LaunchOptions,
  WEBSOCKET_ENDPOINT_REGEX,
} from "@astral/astral";
import { isChildProcessGone } from "@commonfabric/integration/astral-adapter";

/** A browser that has started, and how to reach and wait out its tree. */
type SpawnedBrowser = {
  /** The browser process. */
  child: Deno.ChildProcess;

  /** Host and port of the browser's developer-tools endpoint. */
  endpoint: string;

  /** Resolves once every write end of the browser's standard error is closed. */
  standardErrorClosed: Promise<void>;
};

/**
 * Resolves once every write end of `child`'s standard error has been closed,
 * discarding everything read from it.
 *
 * A process that inherits a pipe holds its write end open until it exits or
 * closes the descriptor, and a browser closes neither, so for a browser and
 * everything it starts this is the point at which the last of them has gone.
 * What is read is discarded rather than left unread because a full pipe blocks
 * the process writing into it.
 *
 * The child has to have been spawned with `stderr: "piped"`, and nothing else
 * may be reading the stream.
 */
export function standardErrorClosed(child: Deno.ChildProcess): Promise<void> {
  const closed = child.stderr.pipeTo(new WritableStream());
  // The promise is awaited at the end of the run rather than here, and a
  // rejection nothing is listening for ends the process where it stands. This
  // handler is what marks it listened for; `closed` still carries the failure
  // to whoever awaits it.
  closed.catch(() => {});
  return closed;
}

/**
 * Kills `child` and returns once every process in its tree has exited.
 *
 * `closed` is what `standardErrorClosed()` returned for the same child. A
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
 * Spawns the browser `options` names and reads its standard error up to the
 * line naming its developer-tools endpoint, handing the rest of that stream to
 * `standardErrorClosed()`.
 *
 * Writes out what the browser printed and throws when it exits before naming
 * an endpoint.
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

  // The profile directory belongs to the run and goes when the run ends. A
  // launch naming none would reach the profile of the browser the developer
  // uses, and write into the directory that profile lives in.
  if (!args.some((argument) => argument.startsWith("--user-data-dir="))) {
    throw new Error("A browser launch has to name a `--user-data-dir`.");
  }

  const command = new Deno.Command(binary, { args, stderr: "piped" });

  const child = command.spawn();
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let printed = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    printed += decoder.decode(value, { stream: true });

    const endpoint = printed.match(WEBSOCKET_ENDPOINT_REGEX)?.[1];
    if (endpoint) {
      reader.releaseLock();
      return {
        child,
        endpoint,
        standardErrorClosed: standardErrorClosed(child),
      };
    }
  }

  const { code } = await child.status;
  // `isRetryableAstralLaunchError()` matches the message below exactly to
  // decide whether the launch is worth another attempt, so what the browser
  // printed is written out here rather than carried in the error.
  console.error(`${printed}\nProcess exited with code ${code}`);
  if (printed.includes("error while loading shared libraries")) {
    throw new Error(
      "Your binary refused to boot due to missing system dependencies",
    );
  }
  throw new Error("Your binary refused to boot");
}

/** A running browser, and the process tree the run can wait out. */
export class BrowserProcess {
  #child: Deno.ChildProcess;
  #standardErrorClosed: Promise<void>;
  #browser: AstralBrowser;

  /**
   * Takes the browser process, the promise `standardErrorClosed()` returned
   * for it, and astral's connection to it. `start()` is what supplies the
   * three of them.
   */
  constructor(
    child: Deno.ChildProcess,
    standardErrorClosed: Promise<void>,
    browser: AstralBrowser,
  ) {
    this.#child = child;
    this.#standardErrorClosed = standardErrorClosed;
    this.#browser = browser;
  }

  /** Astral's connection to the browser, which pages are opened through. */
  get browser(): AstralBrowser {
    return this.#browser;
  }

  /**
   * Closes the browser and returns once every process holding the browser's
   * standard error has closed it, which is once the last of them has exited.
   *
   * The browser is stopped by the signal rather than by astral's `close()`,
   * which asks over the browser's connection and waits for an answer. A
   * browser that has already gone takes that connection with it, and the wait
   * then has nothing to resolve it.
   */
  async close(): Promise<void> {
    try {
      await stopBrowserProcess(this.#child, this.#standardErrorClosed);
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
      const browser = await connect({
        endpoint: spawned.endpoint,
        product: options.product ?? "chrome",
        userAgent: options.userAgent,
      });
      return new BrowserProcess(
        spawned.child,
        spawned.standardErrorClosed,
        browser,
      );
    } catch (error) {
      await stopBrowserProcess(spawned.child, spawned.standardErrorClosed);
      throw error;
    }
  }
}
