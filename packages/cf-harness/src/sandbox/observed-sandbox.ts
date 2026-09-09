/**
 * The run's view of its sandbox: the invocation boundary where the trusted
 * taint evidence is collected.
 *
 * Collection belongs here rather than in the tools because it has to be true
 * of EVERY invocation, and a tool is free to build its command, drop a
 * result, or return early. Taint evidence gathered from tool OUTPUTS is
 * evidence a tool can lose — by collapsing several invocations into one
 * result, by discarding it on an error path, or by never declaring the field.
 * Gathered here, it is a property of having run a container: an invocation
 * that returns no readable CFC result is reported as one, and the run's
 * knowledge becomes a hole.
 *
 * The reverse mistake is just as costly, and is why this sits at the
 * invocation rather than at the tool: a tool that fails BEFORE reaching the
 * sandbox — an unresolvable path, a refused argument — never runs a container
 * and must not be read as one that lost its evidence. Nothing reaches this
 * wrapper unless a container was asked for.
 *
 * One wrapper observes into one run. A delegated child is handed the runtime
 * this wraps rather than the wrapper, so its invocations land in its own
 * record and not in its parent's as well.
 */

import type {
  CfcTransportReadiness,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "./types.ts";

/**
 * What one sandbox invocation left behind. A result is evidence only when the
 * runtime says runsc reported it; one the runtime synthesized because it
 * could not read the sidecar carries an empty label that would otherwise read
 * as a public container.
 */
export type SandboxInvocationObserver = (
  result: SandboxCommandResult | undefined,
) => Promise<void>;

class ObservedSandboxRuntime implements SandboxRuntime {
  readonly #inner: SandboxRuntime;
  readonly #observe: SandboxInvocationObserver;

  constructor(inner: SandboxRuntime, observe: SandboxInvocationObserver) {
    this.#inner = inner;
    this.#observe = observe;
  }

  describe(): SandboxRuntimeDescription {
    return this.#inner.describe();
  }

  probeCfcTransportReadiness(): Promise<CfcTransportReadiness> {
    // Present whether or not the inner runtime has one, so that wrapping a
    // runtime does not change which methods it answers to. A runtime with no
    // registration to read reports a reading for no transport kind, which is
    // what `describe()` already calls unverified — not a claim that nothing
    // is registered.
    return this.#inner.probeCfcTransportReadiness?.() ?? Promise.resolve({});
  }

  resolvePath(path: string, cwd?: string): string {
    return this.#inner.resolvePath(path, cwd);
  }

  isPathWithinWorkspace(path: string): boolean {
    return this.#inner.isPathWithinWorkspace(path);
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.#inner.isPathWithinAllowedRoots(path);
  }

  defaultWorkingDirectory(): string {
    return this.#inner.defaultWorkingDirectory();
  }

  async run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return await this.#observed(() => this.#inner.run(request));
  }

  async runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return await this.#observed(() => this.#inner.runShell(request));
  }

  /**
   * Reports what an invocation left, then hands the result on unchanged.
   *
   * An invocation that THREW ran a container too — a Docker failure, a
   * timeout — and left no result to read, so it is reported before the error
   * travels on. Reporting only on the success path would let a run lose an
   * invocation by having it fail.
   *
   * `start` is a thunk rather than a promise so that a runtime throwing
   * SYNCHRONOUSLY is caught here as well. Evaluating the call before the
   * `try` would let exactly one shape of failure — the one that never reaches
   * a promise — pass unobserved.
   */
  async #observed(
    start: () => Promise<SandboxCommandResult>,
  ): Promise<SandboxCommandResult> {
    let result: SandboxCommandResult;
    try {
      result = await start();
    } catch (error) {
      await this.#observe(undefined);
      throw error;
    }
    await this.#observe(result);
    return result;
  }
}

/** Wraps `runtime` so every invocation reports what it left to `observe`. */
export const observedSandboxRuntime = (
  runtime: SandboxRuntime,
  observe: SandboxInvocationObserver,
): SandboxRuntime => new ObservedSandboxRuntime(runtime, observe);
