import { Bindings } from "./bindings/mod.ts";
import {
  DefaultIntrinsics,
  getQuickJS,
  type QuickJSContext,
  QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "./quick.ts";
import { GuestMessage, SandboxValue } from "../types.ts";
import { Primordials } from "./bindings/primordials.ts";

export interface SandboxStats {
  memoryUsed: number;
}

export const DEFAULT_MEMORY_LIMIT = 1024 * 640;
export const DEFAULT_STACK_SIZE = 1024 * 320;

export interface SandboxConfig {
  // The runtime memory limit, in bytes.
  memoryLimit?: number;
  // The maximum stack size allowed, in bytes.
  stackSize?: number;
}

let QuickJS: QuickJSWASMModule | undefined;

export class Sandbox {
  #bindings: Bindings;
  #rt: QuickJSRuntime;
  #vm: QuickJSContext;
  #disposed: boolean;

  constructor(config: SandboxConfig = {}) {
    if (!QuickJS) {
      throw new Error("Sandbox.initialize() must be called before use.");
    }
    const rt = QuickJS.newRuntime({
      memoryLimitBytes: config.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
      maxStackSizeBytes: config.stackSize ?? DEFAULT_STACK_SIZE,
    });
    this.#vm = rt.newContext({
      // Disable some intrinsics that we cannot yet
      // marshall back to the host
      intrinsics: {
        ...DefaultIntrinsics,
        BigDecimal: false,
        BigInt: false,
        BigFloat: false,
        BignumExt: false,
        OperatorOverloading: false,
        Proxy: false,
        Promise: false,
        // This prevents `vm.evalCode` from working!
        // Eval: false,
      },
    });
    this.#rt = rt;
    this.#bindings = new Bindings(this.#vm);
    this.#disposed = false;
  }

  stats(): SandboxStats {
    using handle = this.#rt.computeMemoryUsage();
    const usage = this.#vm.dump(handle);
    return {
      memoryUsed: usage.memory_used_size as number,
    };
  }

  vm(): QuickJSContext {
    return this.#vm;
  }

  primordials(): Primordials {
    return this.#bindings.primordials();
  }

  messages(): GuestMessage[] {
    return this.#bindings.drainMessages();
  }

  // Invoke a function handle, optionally casting values to the VM,
  // and returning result as a SandboxValue.
  invoke(
    fn: QuickJSHandle,
    self: QuickJSHandle,
    args: QuickJSHandle[] | SandboxValue[],
  ): SandboxValue {
    using result = this.invokeRaw(fn, self, args);
    return this.#bindings.fromVm(result);
  }

  // Invoke a function handle, returning an owned handle.
  invokeRaw(
    fn: QuickJSHandle,
    self: QuickJSHandle,
    args: QuickJSHandle[] | SandboxValue[],
  ): QuickJSHandle {
    const argsAreHandles = args.length > 0 &&
      (typeof args[0] === "object" && args[0] && "dispose" in args[0] &&
        typeof args[0].dispose === "function");

    const input = argsAreHandles
      ? args as QuickJSHandle[]
      : args.map((arg) => this.#bindings.toVm(arg));
    const result = this.#vm.unwrapResult(
      this.#vm.callFunction(
        fn,
        self,
        input,
      ),
    );
    if (!argsAreHandles) {
      for (const arg of input) arg.dispose();
    }
    return result;
  }

  // Invoke a global function by its global name.
  invokeGlobal(
    global: string,
    self: QuickJSHandle,
    args: QuickJSHandle[] | SandboxValue[],
  ): SandboxValue {
    using fn = this.#vm.getProp(this.#vm.global, global);
    return this.invoke(fn, self, args);
  }

  // Load a raw (non-compiled recipe) script.
  // Returns an owned reference to the return value.
  loadRaw(script: string | { js: string; filename?: string }): QuickJSHandle {
    if (this.#disposed) {
      throw new Error(`Sandbox already disposed.`);
    }
    const { js, filename } = typeof script === "object"
      ? script
      : { js: script };
    const result = this.#vm.unwrapResult(
      this.#vm.evalCode(js, filename),
    );
    return result;
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  toVm(value: SandboxValue): QuickJSHandle {
    return this.#bindings.toVm(value);
  }

  fromVm(value: QuickJSHandle): SandboxValue {
    return this.#bindings.fromVm(value);
  }

  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#bindings.dispose();
    this.#vm.dispose();
    this.#rt.dispose();
  }

  static async initialize() {
    if (!QuickJS) {
      QuickJS = await getQuickJS();
    }
  }
}
