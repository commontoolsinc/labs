import { assertEquals } from "@std/assert";
import { isRendererTrustedEvent } from "../../runner/src/cfc/ui-contract.ts";
import { buildActionEvent } from "../lib/trusted-test-event.ts";

const trustedUi = { surface: "pattern-id", action: "save" };

const provenance = {
  origin: "dom",
  trusted: true,
  ui: {
    pattern: "pattern-id",
    eventIntegrity: ["pattern-id"],
    uiContractDataset: { uiAction: "save" },
  },
};

Deno.test("trusted UI action without a payload synthesizes a click event", () => {
  const action = buildActionEvent(undefined, trustedUi);
  assertEquals(action.value, { type: "click", provenance });
  assertEquals(isRendererTrustedEvent(action.value), true);
});

Deno.test("a synthesized click declares both of its fields as injected", () => {
  const action = buildActionEvent(undefined, trustedUi);
  assertEquals(action.sendOptions.runtimeInjectedEventKeys, [
    "type",
    "provenance",
  ]);
});

Deno.test("a step's own payload fields are not declared as injected", () => {
  const action = buildActionEvent({ type: "submit", note: "hi" }, trustedUi);
  assertEquals(action.value, { type: "submit", note: "hi", provenance });
  // `note` and the authored `type` stay the step's own, so a verb whose event
  // schema does not declare them still rejects the send.
  assertEquals(action.sendOptions.runtimeInjectedEventKeys, ["provenance"]);
});

Deno.test("an untrusted action passes its payload through undeclared", () => {
  const action = buildActionEvent({ note: "hi" }, undefined);
  assertEquals(action.value, { note: "hi" });
  assertEquals(action.sendOptions.runtimeInjectedEventKeys, undefined);
});
