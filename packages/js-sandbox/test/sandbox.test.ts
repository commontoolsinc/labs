import { SandboxValue } from "../mod.ts";
import { Sandbox } from "../sandbox/mod.ts";
import { assert, assertEquals } from "@std/assert";

const SCRIPT = `
globalThis.reflectArgs = (...args) => args;
`;

Deno.test("Sandbox - types", async function () {
  await Sandbox.initialize();
  using sandbox = new Sandbox();
  sandbox.loadRaw({ js: SCRIPT }).dispose();

  function invoke(arg: SandboxValue): any {
    const result = sandbox.invokeGlobal("reflectArgs", sandbox.vm().undefined, [
      arg,
    ]);
    if (!Array.isArray(result)) {
      throw new Error("Expected array result");
    }
    return result[0];
  }

  assertEquals(invoke(5), 5, "reflects numbers.");
  assertEquals(invoke("hi"), "hi", "reflects strings.");
  assertEquals(invoke(true), true, "reflects `true`.");
  assertEquals(invoke(false), false, "reflects `false`.");
  assertEquals(invoke(null), null, "reflects `null`.");
  // `undefined` in an array when returned from a sandboxed function casts to null.(???)
  assertEquals(invoke(undefined), null, "reflects `undefined`.");
  assertEquals(invoke({ foo: 1, bar: { baz: 2 } }), {
    foo: 1,
    bar: { baz: 2 },
  }, "reflects objects.");
  assertEquals(invoke([1, 2, 3]), [1, 2, 3], "reflects arrays.");
});

Deno.test("Sandbox - environment", async function () {
  await Sandbox.initialize();
  using sandbox = new Sandbox();

  sandbox.loadRaw(`
  globalThis.assert = (cond, message) => {
    if (!cond) throw new Error("Assertion failed: " + message); }`).dispose();

  const supported: [string, string][] = [
    ["JSON.parse()", "JSON.parse('{\"a\":5}')"],
    ["JSON.stringify()", "JSON.stringify({a:5})"],
    ["Date.now()", "Date.now()"],
    ["eval()", "eval('1+1')"], // we must support `eval` for `vm.evalCode` to even work
    ["new Uint8Array()", "new Uint8Array([1,2,3])"],
  ];
  check(supported, true);

  const unsupported: [string, string][] = [
    ["new Promise()", "new Promise()"],
    ["BigInt()", "BigInt(100000000000)"],
  ];
  check(unsupported, false);

  function check(cases: [string, string][], expectToPass: boolean) {
    for (const [name, testCase] of cases) {
      let thrown = false;
      try {
        sandbox.loadRaw(testCase).dispose();
      } catch (e) {
        thrown = true;
      }
      assert(
        expectToPass !== thrown,
        `${name} is${expectToPass ? "" : "not"} supported in the environment.`,
      );
    }
  }
});

Deno.test("Sandbox - primordials", async function () {
  await Sandbox.initialize();
  using sandbox = new Sandbox();
  // Clobber global
  sandbox.loadRaw(
    `globalThis.Uint8Array = function Uint8Array() { throw new Error("USERLAND") }`,
  ).dispose();

  using handle = sandbox.primordials().newUint8Array(
    new Uint8Array([1, 2, 3]).buffer,
  );
  sandbox.loadRaw(`globalThis.testUint8Array = function test(input) {
    if (input instanceof Uint8Array) return 0;
    const array = Array.from(input);
    if (array[0] !== 1 || array[1] !== 2 || array[2] !== 3) return 0;
    return 1;
  }`).dispose();
  const result = sandbox.invokeGlobal("testUint8Array", sandbox.vm().null, [
    handle,
  ]);
  assert(
    result === 1,
    "Primordial Uint8Array was used instead of userland.",
  );
});
