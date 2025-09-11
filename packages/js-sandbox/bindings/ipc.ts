import { QuickJSContext } from "../quick.ts";

export function bindIpc(
  vm: QuickJSContext,
  callback: (message: unknown) => void,
) {
  using ipc = vm.newObject();
  using sendHandle = vm.newFunction("send", (message: unknown) => {
    callback(message);
  });
  vm.setProp(ipc, "send", sendHandle);
  vm.setProp(vm.global, "__ipc", ipc);
}
