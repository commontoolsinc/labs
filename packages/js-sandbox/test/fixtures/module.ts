export const callConsole = (
  method: "log" | "info" | "error",
  ...args: unknown[]
) => {
  if (method in console) {
    globalThis.console[method](...args);
  }
};

export const reflectArgs = (...args: unknown[]): unknown[] => {
  return args;
};

console.log("initial eval", 5, [{ foo: 1 }]);

export default "mainexport";
