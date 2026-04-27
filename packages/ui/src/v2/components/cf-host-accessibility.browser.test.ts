import { assertEquals, assertInstanceOf } from "@std/assert";
import { CFButton } from "./cf-button/cf-button.ts";
import { CFInput } from "./cf-input/cf-input.ts";

Deno.test("cf-button and cf-input can be created by document.createElement", async () => {
  if (typeof document === "undefined") {
    return;
  }

  const button = document.createElement("cf-button") as CFButton;
  const input = document.createElement("cf-input") as CFInput;

  document.body.append(button, input);
  await Promise.all([button.updateComplete, input.updateComplete]);

  assertInstanceOf(button, CFButton);
  assertEquals(button.getAttribute("role"), "button");
  assertEquals(button.getAttribute("exportparts"), "button");

  assertInstanceOf(input, CFInput);
  assertEquals(input.getAttribute("role"), "textbox");
  assertEquals(input.getAttribute("exportparts"), "input");

  button.remove();
  input.remove();
});
