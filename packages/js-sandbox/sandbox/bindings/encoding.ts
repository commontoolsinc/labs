import { QuickJSContext, QuickJSHandle } from "../quick.ts";
import { SandboxValue } from "../../types.ts";
import { Primordials } from "./primordials.ts";

type BindingsProvider = {
  vm(): QuickJSContext;
  primordials(): Primordials;
};

export function toVm(
  provider: BindingsProvider,
  input: SandboxValue,
): QuickJSHandle {
  const vm = provider.vm();
  const primordials = provider.primordials();
  switch (typeof input) {
    case "undefined": {
      return vm.undefined;
    }
    case "number": {
      return vm.newNumber(input);
    }
    case "boolean": {
      return input ? vm.true : vm.false;
    }
    case "string": {
      return vm.newString(input);
    }
    case "object": {
      if (input === null) {
        return vm.null;
      } else if (input instanceof Uint8Array) {
        return primordials.newUint8Array(input.buffer as ArrayBuffer);
      } else if (Array.isArray(input)) {
        const array = vm.newArray();
        for (let i = 0; i < input.length; i++) {
          using child = toVm(provider, input[i] as SandboxValue);
          vm.setProp(array, i, child);
        }
        return array;
      } else {
        const obj = vm.newObject();
        for (const [key, value] of Object.entries(input)) {
          using child = toVm(provider, value as SandboxValue);
          vm.setProp(obj, key, child);
        }
        return obj;
      }
    }
    default: {
      throw new Error("Cannot serialize type.");
    }
  }
}

// Currently, we use the VM's `dump` method to essentially
// JSON stringify/parse the value from the VM. This fails
// to translate complex objects like Uint8Array or Map.
//
// Options to marshall e.g. a typed array from the VM, all
// involving overhead compared to `dump`, a challenge to support
// both Uint8Array in a nested object, as well as large arrays
// with polymorphic values:
//
// * Manually walk a value graph: would require many calls to the VM
// for type inspection.
// * Parse once in VM with sigils: We could replace complex
// objects that can be represented by some internal symbol
// e.g. `{ @SandboxType: "uint8array", value: Uint8Array }`
export function fromVm(
  provider: BindingsProvider,
  input: QuickJSHandle,
): any {
  return provider.vm().dump(input);
}
