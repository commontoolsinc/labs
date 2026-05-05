import { Sandbox } from "../sandbox/mod.ts";
import { assertEquals } from "@std/assert";

const SCRIPT = {
  js: `
globalThis.callConsole = (method, ...args) => {
  if (method in globalThis.console) {
    globalThis.console[method](...args);
  }
};
`,
};

Deno.test("sandbox - console hooks", async function () {
  await Sandbox.initialize();
  using sandbox = new Sandbox();
  sandbox.loadRaw(SCRIPT).dispose();
  const messages = sandbox.messages();
  assertEquals(messages.length, 0);

  const args = [
    "helloworld",
    10,
    // `undefined` is cast to null when nested.
    //undefined,
    null,
    {
      "bar": 2,
    },
  ] as [string, number, null, Record<string, number | undefined>];

  sandbox.invokeGlobal("callConsole", sandbox.vm().undefined, ["log", ...args]);

  const message = sandbox.messages().pop()!;
  assertEquals(message, {
    type: "console",
    method: "log",
    args,
  }, "Fires a console message with args.");
});
