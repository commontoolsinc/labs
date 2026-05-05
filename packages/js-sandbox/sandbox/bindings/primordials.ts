import { QuickJSContext, QuickJSHandle } from "../quick.ts";

export class Primordials {
  #vm: QuickJSContext;
  #handle: QuickJSHandle;
  constructor(vm: QuickJSContext, handle: QuickJSHandle) {
    this.#vm = vm;
    this.#handle = handle;
  }

  handle(): QuickJSHandle {
    return this.#handle;
  }

  newUint8Array(input: ArrayBuffer): QuickJSHandle {
    const vm = this.#vm;
    using arrayBuffer = vm.newArrayBuffer(input);
    return vm.unwrapResult(
      vm.callMethod(this.#handle, "NewUint8Array", [arrayBuffer]),
    );
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  dispose() {
    this.#handle.dispose();
  }
}
