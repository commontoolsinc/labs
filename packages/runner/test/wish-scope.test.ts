import { assertEquals } from "@std/assert";
import { wishTargetMayUseHomeSpace } from "../src/builtins/wish.ts";

Deno.test("wish target scope can be user before reactive query materializes", () => {
  assertEquals(wishTargetMayUseHomeSpace(undefined, [".", "~"]), true);
});

Deno.test("hashtag wish defaults to home-space search", () => {
  assertEquals(wishTargetMayUseHomeSpace("#googleAuth", undefined), true);
});

Deno.test("current-space-only hashtag wish does not use home space", () => {
  assertEquals(wishTargetMayUseHomeSpace("#googleAuth", ["."]), false);
});
