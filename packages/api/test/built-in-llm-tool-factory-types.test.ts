import type { BuiltInLLMTool, Pattern, PatternFactory } from "commonfabric";

const factory = undefined as unknown as PatternFactory<
  { query: string },
  { answer: string }
>;
const legacyPattern = undefined as unknown as Pattern;

Deno.test("BuiltInLLMTool accepts canonical direct and metadata factory shapes", () => {
  const direct: BuiltInLLMTool = factory;
  const wrapped: BuiltInLLMTool = {
    pattern: factory,
    description: "Search",
    useResultSchemaForObservation: true,
  };
  const legacy: BuiltInLLMTool = {
    pattern: legacyPattern,
    extraParams: { source: "stored compatibility value" },
  };

  void direct;
  void wrapped;
  void legacy;
});
