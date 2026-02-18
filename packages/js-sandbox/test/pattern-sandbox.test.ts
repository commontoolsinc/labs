import { PatternSandbox } from "../mod.ts";
import { assert, assertEquals } from "@std/assert";
import { compile } from "./utils.ts";
import { expect } from "@std/expect";

const SCRIPT = await compile(`
export const reflectArgs = (...args: any[]) => args;
export default "mainexport";
`);

Deno.test("PatternSandbox - state", async function () {
  await PatternSandbox.initialize();
  const sandbox = new PatternSandbox();
  expect(() => sandbox.invoke("no", "no", [])).toThrow();
  sandbox.load(SCRIPT);
  expect(() => sandbox.load(SCRIPT)).toThrow();
  sandbox.dispose();
  sandbox.dispose();
  expect(() => sandbox.invoke("no", "no", [])).toThrow();
});

Deno.test("PatternSandbox - main export", async function () {
  await PatternSandbox.initialize();
  using sandbox = new PatternSandbox();
  const main = sandbox.load(SCRIPT);
  assert(main && typeof main === "object" && "default" in main);
  assert(main.default === "mainexport", "Load returns the main export.");
});

Deno.test("PatternSandbox - invoke", async function () {
  await PatternSandbox.initialize();
  using sandbox = new PatternSandbox();
  sandbox.load(SCRIPT);
  assertEquals(sandbox.invoke("/main.tsx", "reflectArgs", [1, "hi", false]), [
    1,
    "hi",
    false,
  ], "Invokes function by bundle filename and export.");
});
