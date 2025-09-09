import { QuickJSContext, QuickJSHandle } from "./quick.ts";
import { SandboxValue } from "./types.ts";

export function serialize(
  vm: QuickJSContext,
  input: SandboxValue,
): QuickJSHandle {
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
      } else if (Array.isArray(input)) {
        const array = vm.newArray();
        for (let i = 0; i < input.length; i++) {
          // Cast value to SandboxValue as we cannot have circular
          // type references for objects(?).
          vm.setProp(array, i, serialize(vm, input[i] as SandboxValue));
        }
        return array;
      } else {
        const obj = vm.newObject();
        for (const [key, value] of Object.entries(input)) {
          // Cast value to SandboxValue as we cannot have circular
          // type references for objects(?).
          vm.setProp(obj, key, serialize(vm, value as SandboxValue));
        }
        return obj;
      }
    }
    default: {
      throw new Error("Cannot serialize type.");
    }
  }
}

export function deserialize(
  vm: QuickJSContext,
  input: QuickJSHandle,
): any {
  return vm.dump(input);
}
