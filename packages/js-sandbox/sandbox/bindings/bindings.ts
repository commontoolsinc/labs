import { GuestMessage, isGuestMessage, SandboxValue } from "../../types.ts";
import { QuickJSContext, QuickJSHandle } from "../quick.ts";
import Script_00_Primordials from "./environment/00_primordials.js" with {
  type: "text",
};
import Script_01_Console from "./environment/01_console.js" with {
  type: "text",
};
import { fromVm, toVm } from "./encoding.ts";
import { Primordials } from "./primordials.ts";

// Order of scripts to be injected. Primordials
// must be registered first, as they're used as args
// for later injected scripts.
const injectScripts = [
  Script_01_Console,
];

export class Bindings {
  #vm: QuickJSContext;
  #primordials: Primordials;
  #messages: GuestMessage[] = [];

  constructor(vm: QuickJSContext) {
    this.#vm = vm;

    // Create IPC
    using ipc = vm.newObject();
    using sendHandle = vm.newFunction("send", (data) => {
      this.#onGuestMessage(this.fromVm(data));
    });
    vm.setProp(ipc, "send", sendHandle);
    vm.setProp(vm.global, "__ipc", ipc);

    // Register primordials
    this.#primordials = new Primordials(
      vm,
      vm.unwrapResult(
        vm.evalCode(Script_00_Primordials),
      ),
    );

    // Register other scripts
    for (const script of injectScripts) {
      using handle = vm.unwrapResult(
        vm.evalCode(script),
      );
      vm.unwrapResult(
        vm.callFunction(handle, vm.null, [this.#primordials.handle()]),
      )
        .dispose();
    }
  }

  primordials(): Primordials {
    return this.#primordials;
  }

  vm(): QuickJSContext {
    return this.#vm;
  }

  drainMessages(): GuestMessage[] {
    const messages = [...this.#messages];
    this.#messages.length = 0;
    return messages;
  }

  // Cast a value into the VM, returning an owned handle.
  toVm(value: SandboxValue): QuickJSHandle {
    return toVm(this, value);
  }

  // Cast a value from the VM.
  fromVm(value: QuickJSHandle): SandboxValue {
    return fromVm(this, value);
  }

  #onGuestMessage = (message: unknown) => {
    if (!isGuestMessage(message)) {
      let formatted;
      try {
        formatted = JSON.stringify(message);
      } catch (e) {
        if (
          message && typeof message === "object" && "toString" in message &&
          typeof message.toString === "function"
        ) {
          formatted = message.toString() as string;
        } else {
          formatted = message;
        }
      }
      this.#messages.push({
        type: "error",
        error: `Received invalid message: ${formatted}`,
      });
      return;
    }
    this.#messages.push(message);
  };

  [Symbol.dispose]() {
    this.dispose();
  }

  dispose() {
    this.#primordials.dispose();
  }
}
