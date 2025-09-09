import { GuestMessage } from "../types.ts";
import { QuickJSContext } from "../quick.ts";

enum ConsoleMethod {
  Assert = "assert",
  Clear = "clear",
  Count = "count",
  CountReset = "countReset",
  Debug = "debug",
  Dir = "dir",
  DirXml = "dirxml",
  Error = "error",
  Group = "group",
  GroupCollapsed = "groupCollapsed",
  GroupEnd = "groupEnd",
  Info = "info",
  Log = "log",
  Table = "table",
  Time = "time",
  TimeEnd = "timeEnd",
  TimeLog = "timeLog",
  TimeStamp = "timeStamp",
  Trace = "trace",
  Warn = "warn",
}

const ConsoleMethods: readonly ConsoleMethod[] = Object.values(
  ConsoleMethod,
);

export function bindConsole(
  vm: QuickJSContext,
  callback: (message: GuestMessage) => void,
) {
  using console = vm.newObject();

  ConsoleMethods.forEach((method) => {
    using handle = vm.newFunction(method, (...args: any[]) => {
      callback({ type: "console", method, args: args.map(vm.dump) });
    });
    vm.setProp(console, method, handle);
  });

  vm.setProp(vm.global, "console", console);
}
