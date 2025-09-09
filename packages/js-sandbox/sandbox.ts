import { deserialize, serialize } from "./encoding.ts";
import { Bindings } from "./bindings/mod.ts";
import {
  getQuickJS,
  type QuickJSContext,
  QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "./quick.ts";
import { type JsScript } from "@commontools/js-runtime";
import { GuestMessage, SandboxValue } from "./types.ts";

let QuickJS: QuickJSWASMModule | undefined;

type SandboxState = "unloaded" | "loaded" | "disposed";

export class Sandbox {
  #state: SandboxState;
  #bindings: Bindings;
  #rt: QuickJSRuntime;
  #vm: QuickJSContext;

  // Bundle function return value containing
  // "main" property, and "exportMap" property.
  #exports?: QuickJSHandle;

  constructor() {
    if (!QuickJS) {
      throw new Error("Sandbox.initialize() must be called before use.");
    }
    const rt = QuickJS.newRuntime();
    rt.setMemoryLimit(1024 * 640);
    rt.setMaxStackSize(1024 * 320);
    this.#vm = rt.newContext();
    this.#rt = rt;
    this.#bindings = new Bindings(this.#vm);
    this.#state = "unloaded";
  }

  messages(): GuestMessage[] {
    return this.#bindings.drainMessages();
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
    using exportMap = this.#vm.getProp(this.#exports, "exportMap");
    using fileExports = this.#vm.getProp(exportMap, exportFile);
    using fn = this.#vm.getProp(fileExports, exportName);

    const serialized = args.map((arg) => serialize(this.#vm, arg));
    using result = this.#vm.unwrapResult(
      this.#vm.callFunction(
        fn,
        this.#vm.undefined,
        serialized,
      ),
    );

    for (const arg of serialized) arg.dispose();

    return deserialize(this.#vm, result);
  }

  // Load and evaluate a script within the sandbox.
  //
  // In the future, this could be a Module, but for now,
  // remain compatible with how `js-runtime` bundles the TypeScript:
  // as a function that returns an object containing the original
  // ES exports in TypeScript as key-value pairs.
  load(module: JsScript): unknown {
    if (this.#state !== "unloaded") {
      throw new Error(`Cannot load script in ${this.#state} sandbox.`);
    }
    using result = this.#vm.unwrapResult(
      this.#vm.evalCode(module.js, module.filename),
    );
    using runtimeDeps = this.#vm.newObject();
    this.#exports = this.#vm.unwrapResult(this.#vm.callFunction(
      result,
      this.#vm.undefined,
      runtimeDeps,
    ));

    this.#state = "loaded";
    using main = this.#vm.getProp(this.#exports, "main");
    return deserialize(this.#vm, main);
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
    this.#vm.dispose();
    this.#rt.dispose();
  }

  static async initialize() {
    if (!QuickJS) {
      QuickJS = await getQuickJS();
    }
  }
}
