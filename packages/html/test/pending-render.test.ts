import { assertEquals } from "@std/assert";
import * as pendingRender from "../src/pending-render.ts";

Deno.test("pending render state marks retained content inert and busy", () => {
  const attributes = new Map<string, string>();
  const element = {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } as unknown as Node;

  pendingRender.setPendingRenderState(element, true);
  assertEquals(attributes.get("data-cf-pending"), "true");
  assertEquals(attributes.get("inert"), "");
  assertEquals(attributes.get("aria-busy"), "true");

  pendingRender.setPendingRenderState(element, false);
  assertEquals(attributes.size, 0);
});

Deno.test("pending render helper owns semantics, not presentation", () => {
  assertEquals("ensurePendingRenderStyles" in pendingRender, false);
  assertEquals("PENDING_RENDER_STYLES" in pendingRender, false);
});
