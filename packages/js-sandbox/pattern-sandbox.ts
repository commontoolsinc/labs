import { QuickJSHandle } from "./sandbox/quick.ts";
import { type JsScript } from "@commontools/js-compiler";
import { GuestMessage, SandboxValue } from "./types.ts";
import { Sandbox, SandboxConfig, SandboxStats } from "./sandbox/mod.ts";

type SandboxState = "unloaded" | "loaded" | "disposed";

// A VM to execute pattern code.
//
// Before usage, `await PatternSandbox.initialize()`
// must be called at least once.
//
// Each sandbox can load a single pattern compiled with
// `js-compiler`, and then loaded via `sandbox.load(..)`.
// Functions exported by the typescript modules can be
// then be invoked.
export class PatternSandbox {
  #state: SandboxState;
  #sandbox: Sandbox;
  // Bundle function return value containing
  // "main" property, and "exportMap" property.
  #exports?: QuickJSHandle;

  constructor(config: SandboxConfig = {}) {
    this.#sandbox = new Sandbox(config);
    this.#state = "unloaded";
  }

  messages(): GuestMessage[] {
    return this.#sandbox.messages();
  }

  // Invoke function exported by load script.
  invoke(
    exportFile: string,
    exportName: string,
    args: SandboxValue[],
  ): unknown {
    if (this.#state !== "loaded" || !this.#exports) {
      throw new Error(`Cannot invoke a non-loaded sandbox.`);
    }
    const vm = this.#sandbox.vm();
    using exportMap = vm.getProp(this.#exports, "exportMap");
    using fileExports = vm.getProp(exportMap, exportFile);
    using fn = vm.getProp(fileExports, exportName);

    return this.#sandbox.invoke(fn, vm.undefined, args);
  }

  // Load and evaluate a compiled pattern script within the sandbox.
  load(module: JsScript): unknown {
    if (this.#state !== "unloaded") {
      throw new Error(`Cannot load script in ${this.#state} sandbox.`);
    }
    const vm = this.#sandbox.vm();
    using result = this.#sandbox.loadRaw(module);
    this.#exports = this.#sandbox.invokeRaw(result, vm.undefined, [{}]);
    using main = vm.getProp(this.#exports, "main");
    this.#state = "loaded";
    return this.#sandbox.fromVm(main);
  }

  stats(): SandboxStats {
    return this.#sandbox.stats();
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  dispose() {
    if (this.#state === "disposed") {
      return;
    }
    this.#state = "disposed";
    if (this.#exports) this.#exports.dispose();
    this.#sandbox.dispose();
  }

  static async initialize() {
    await Sandbox.initialize();
  }
}
