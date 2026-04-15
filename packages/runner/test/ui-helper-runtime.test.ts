import { assertEquals } from "@std/assert";
import { UiAction, UiDisclosure, UiPromptSlot } from "@commonfabric/html";
import { createBuilder } from "../src/builder/factory.ts";

Deno.test(
  "builder exports the same runtime UI helper shape as @commonfabric/html",
  () => {
    const { commonfabric } = createBuilder();

    assertEquals(
      commonfabric.UiAction({
        action: "SubmitDirectCommand",
        children: "Go",
      }),
      UiAction({
        action: "SubmitDirectCommand",
        children: "Go",
      }),
    );

    assertEquals(
      commonfabric.UiPromptSlot({
        surface: "PromptPane",
        role: "assistant",
      }),
      UiPromptSlot({
        surface: "PromptPane",
        role: "assistant",
      }),
    );

    assertEquals(
      commonfabric.UiDisclosure({
        kind: "warning",
        children: "Heads up",
      }),
      UiDisclosure({
        kind: "warning",
        children: "Heads up",
      }),
    );
  },
);
