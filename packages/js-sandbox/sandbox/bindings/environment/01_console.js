((PRIMORDIALS) => {
  const methods = [
    "assert",
    "clear",
    "count",
    "countReset",
    "debug",
    "dir",
    "dirxml",
    "error",
    "group",
    "groupCollapsed",
    "groupEnd",
    "info",
    "log",
    "table",
    "time",
    "timeEnd",
    "timeLog",
    "timeStamp",
    "trace",
    "warn",
  ];

  const console = globalThis.console = PRIMORDIALS.ObjectCreate(null);
  for (const method of methods) {
    console[method] = PRIMORDIALS.FunctionBind(consoleHandler, console, method);
  }
  PRIMORDIALS.ObjectFreeze(console);

  function consoleHandler(method, ...args) {
    PRIMORDIALS.IpcSend({
      type: "console",
      method,
      args,
    });
  }
});
