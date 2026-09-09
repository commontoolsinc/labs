/**
 * The run family's view of its sandbox: the invocation boundary where the
 * output directory is announced and the trusted taint evidence is collected.
 *
 * Both jobs belong here rather than in the tools because both have to be true
 * of EVERY invocation, and a tool is free to build its command, drop a
 * result, or return early. `CF_HARNESS_OUTPUT_DIR` reaching only the commands
 * five tools happen to build would leave a sixth without it. More sharply,
 * taint evidence gathered from tool OUTPUTS is evidence a tool can lose — by
 * collapsing several invocations into one result, by discarding it on an
 * error path, or by never declaring the field. Gathered here, it is a
 * property of having run a container: an invocation that returns no readable
 * CFC result is reported as one, and the family's knowledge becomes a hole.
 *
 * The reverse mistake is just as costly, and is why this sits at the
 * invocation rather than at the tool: a tool that fails BEFORE reaching the
 * sandbox — an unresolvable path, a refused argument — never runs a container
 * and must not be read as one that lost its evidence. Nothing reaches this
 * wrapper unless a container was asked for.
 *
 * The environment overlay is applied UNDER the request's own, so a caller
 * that sets the same name wins. That direction is deliberate: nothing here
 * decides policy, and a variable this adds is a convenience for finding a
 * directory rather than a claim anything trusts.
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

class FamilySandboxRuntime implements SandboxRuntime {
  readonly #inner: SandboxRuntime;
  readonly #env: Readonly<Record<string, string>>;
  readonly #observe: SandboxInvocationObserver;

  constructor(
    inner: SandboxRuntime,
    env: Readonly<Record<string, string>>,
    observe: SandboxInvocationObserver,
  ) {
    this.#inner = inner;
    this.#env = { ...env };
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
    return await this.#observed(() =>
      this.#inner.run({ ...request, env: this.#merged(request.env) })
    );
  }

  async runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return await this.#observed(() =>
      this.#inner.runShell({ ...request, env: this.#merged(request.env) })
    );
  }

  /**
   * Reports what an invocation left, then hands the result on unchanged.
   *
   * An invocation that THREW ran a container too — a Docker failure, a
   * timeout — and left no result to read, so it is reported before the error
   * travels on. Reporting only on the success path would let a family lose an
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

  #merged(
    env: Record<string, string> | undefined,
  ): Record<string, string> {
    return { ...this.#env, ...env };
  }
}

/**
 * Wraps `runtime` so every invocation carries `env` beneath its own and
 * reports what it left to `observe`.
 */
export const familySandboxRuntime = (
  runtime: SandboxRuntime,
  env: Readonly<Record<string, string>>,
  observe: SandboxInvocationObserver,
): SandboxRuntime => new FamilySandboxRuntime(runtime, env, observe);
