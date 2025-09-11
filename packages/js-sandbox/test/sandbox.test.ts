import { Sandbox, SandboxValue } from "../mod.ts";
import { assert, assertObjectMatch } from "@std/assert";
import { compile } from "./utils.ts";
import MODULE_SRC from "./fixtures/module.ts" with { type: "text" };
import { expect } from "@std/expect";

const SCRIPT = await compile(MODULE_SRC);

Deno.test("sandbox - state", async function () {
  await Sandbox.initialize();
  const sandbox = new Sandbox();
  expect(() => sandbox.invoke("no", "no", [])).toThrow();
  sandbox.load(SCRIPT);
  expect(() => sandbox.load(SCRIPT)).toThrow();
  sandbox.dispose();
  sandbox.dispose();
  expect(() => sandbox.invoke("no", "no", [])).toThrow();
});

Deno.test("sandbox - main export", async function () {
  await Sandbox.initialize();
  using sandbox = new Sandbox();
  const main = sandbox.load(SCRIPT);
  assert(main && typeof main === "object" && "default" in main);
  assert(main.default === "mainexport", "Load returns the main export.");
});

Deno.test("sandbox - type casting", async function () {
  await Sandbox.initialize();
  using sandbox = new Sandbox();
  sandbox.load(SCRIPT);

  function invoke(arg: SandboxValue): any {
    const result = sandbox.invoke("/main.tsx", "reflectArgs", [
      arg,
    ]);
    if (!Array.isArray(result)) {
      throw new Error("Expected array result");
    }
    return result[0];
  }

  assert(invoke(5) === 5);
  assert(invoke("hi") === "hi");
  assert(invoke(true) === true);
  assert(invoke(false) === false);
  assert(invoke(null) === null);
  // `undefined` in an array when returned from a sandboxed function casts to null.(???)
  assert(invoke(undefined) === null);
  assert((invoke({ foo: 1 }) as Record<string, number>).foo === 1);
  assert((invoke([123]) as number[])[0] === 123);
});

Deno.test("sandbox - console hooks", async function () {
  await Sandbox.initialize();
  using sandbox = new Sandbox();
  sandbox.load(SCRIPT);
  const messages = sandbox.messages();
  assert(messages.length === 1);
  assertObjectMatch(messages.pop()!, {
    type: "console",
    method: "log",
    args: ["initial eval", 5, [{ foo: 1 }]],
  }, "Console messages are propagated");

  sandbox.invoke("/main.tsx", "callConsole", [
    "log",
    "helloworld",
    10,
    undefined,
    null,
    {
      "foo": undefined,
      "bar": 2,
    },
  ]) as [string, number, undefined, null, Record<string, number | undefined>];

  const message = sandbox.messages().pop()!;
  assert(message);
  assert(message.type === "console");
  assert(message.method === "log");
  const result = message.args as any[];
  assert(result[0] === "helloworld");
  assert(result[1] === 10);
  assert(result[2] === undefined);
  assert(result[3] === null);
  assertObjectMatch(result[4], {
    // Properties with value `undefined` get filtered out
    // when passed into an invoke function. (???)
    "bar": 2,
  });
});
