import { RecipeSandbox, SandboxValue } from "../mod.ts";
import { assert, assertEquals } from "@std/assert";
import { compile } from "./utils.ts";
import { expect } from "@std/expect";

const SCRIPT = await compile(`
export const reflectArgs = (...args: any[]) => args;
export default "mainexport";
`);

Deno.test("RecipeSandbox - state", async function () {
  await RecipeSandbox.initialize();
  const sandbox = new RecipeSandbox();
  expect(() => sandbox.invoke("no", "no", [])).toThrow();
  sandbox.load(SCRIPT);
  expect(() => sandbox.load(SCRIPT)).toThrow();
  sandbox.dispose();
  sandbox.dispose();
  expect(() => sandbox.invoke("no", "no", [])).toThrow();
});

Deno.test("RecipeSandbox - main export", async function () {
  await RecipeSandbox.initialize();
  using sandbox = new RecipeSandbox();
  const main = sandbox.load(SCRIPT);
  assert(main && typeof main === "object" && "default" in main);
  assert(main.default === "mainexport", "Load returns the main export.");
});

Deno.test("RecipeSandbox - invoke", async function () {
  await RecipeSandbox.initialize();
  using sandbox = new RecipeSandbox();
  sandbox.load(SCRIPT);
  assertEquals(sandbox.invoke("/main.tsx", "reflectArgs", [1, "hi", false]), [
    1,
    "hi",
    false,
  ], "Invokes function by bundle filename and export.");
});
