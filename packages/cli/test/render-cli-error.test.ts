import { assert, assertEquals } from "@std/assert";
import { CompilerError, TransformerError } from "@commonfabric/js-compiler";
import { ValidationError } from "@cliffy/command";
import { renderCliError } from "../mod.ts";

Deno.test("renderCliError prints a TransformerError's message, not its stack", () => {
  const e = new TransformerError([], new Map());
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints a CompilerError's message, not its stack", () => {
  const e = new CompilerError([]);
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints a ValidationError's message, not its stack", () => {
  const e = new ValidationError("bad option");
  assertEquals(renderCliError(e), e.message);
  assert(renderCliError(e) !== e.stack);
});

Deno.test("renderCliError prints a plain Error's stack", () => {
  const e = new Error("boom");
  assertEquals(renderCliError(e), e.stack);
});

Deno.test("renderCliError falls back to the message when an Error has no stack", () => {
  const e = new Error("boom");
  e.stack = undefined;
  assertEquals(renderCliError(e), "boom");
});

Deno.test("renderCliError passes a non-Error value through unchanged", () => {
  assertEquals(renderCliError("oops"), "oops");
  assertEquals(renderCliError(42), 42);
});
