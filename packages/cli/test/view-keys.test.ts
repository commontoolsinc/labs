import { assertEquals } from "@std/assert";
import { decodeKeys } from "../lib/view/keys.ts";
import { bytes, raw } from "./view-helpers.ts";

function names(input: Uint8Array): string[] {
  return decodeKeys(input).keys.map((k) => k.name);
}

Deno.test("decode: printable characters and space", () => {
  const { keys } = decodeKeys(bytes("a/?"));
  assertEquals(keys.map((k) => k.name), ["a", "/", "?"]);
  assertEquals(keys[0].char, "a");
  assertEquals(names(bytes(" ")), ["space"]);
});

Deno.test("decode: enter, tab, backspace", () => {
  assertEquals(names(raw(0x0d)), ["enter"]);
  assertEquals(names(raw(0x0a)), ["enter"]);
  assertEquals(names(raw(0x09)), ["tab"]);
  assertEquals(names(raw(0x7f)), ["backspace"]);
  assertEquals(names(raw(0x08)), ["backspace"]);
});

Deno.test("decode: control combinations", () => {
  assertEquals(names(raw(0x03)), ["ctrl-c"]);
  assertEquals(names(raw(0x04)), ["ctrl-d"]);
  assertEquals(names(raw(0x06)), ["ctrl-f"]);
  assertEquals(names(raw(0x02)), ["ctrl-b"]);
});

Deno.test("decode: arrow keys (CSI)", () => {
  assertEquals(names(raw(0x1b, 0x5b, 0x41)), ["up"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x42)), ["down"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x43)), ["right"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x44)), ["left"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x48)), ["home"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x46)), ["end"]);
});

Deno.test("decode: page up/down and home/end (tilde sequences)", () => {
  assertEquals(names(raw(0x1b, 0x5b, 0x35, 0x7e)), ["pageup"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x36, 0x7e)), ["pagedown"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x31, 0x7e)), ["home"]);
  assertEquals(names(raw(0x1b, 0x5b, 0x34, 0x7e)), ["end"]);
});

Deno.test("decode: SS3 arrows (application mode)", () => {
  assertEquals(names(raw(0x1b, 0x4f, 0x41)), ["up"]);
  assertEquals(names(raw(0x1b, 0x4f, 0x44)), ["left"]);
});

Deno.test("decode: lone ESC is Escape", () => {
  assertEquals(names(raw(0x1b)), ["escape"]);
});

Deno.test("decode: a CSI split across reads parses via the leftover buffer", () => {
  const first = decodeKeys(raw(0x1b, 0x5b));
  assertEquals(first.keys.length, 0);
  assertEquals(first.rest, raw(0x1b, 0x5b));
  const second = decodeKeys(new Uint8Array([...first.rest, 0x41]));
  assertEquals(second.keys.map((k) => k.name), ["up"]);
  assertEquals(second.rest.length, 0);
});

Deno.test("decode: mixed batch in one read", () => {
  // 'j' then Down then Enter
  const input = new Uint8Array([0x6a, 0x1b, 0x5b, 0x42, 0x0d]);
  assertEquals(names(input), ["j", "down", "enter"]);
});

Deno.test("decode: multibyte UTF-8 character", () => {
  const { keys } = decodeKeys(bytes("λ"));
  assertEquals(keys.length, 1);
  assertEquals(keys[0].name, "λ");
  assertEquals(keys[0].char, "λ");
});
