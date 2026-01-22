/// <cts-enable />
import {
  computed,
  generateObject,
  pattern,
  patternTool,
  toSchema,
  UI,
  wish,
  type WishState,
  Writable,
} from "commontools";
import { fetchAndRunPattern, listPatternIndex } from "./common-tools.tsx";

// Types from home.tsx learned section
type Fact = {
  content: string;
  confidence: number;
};

type Preference = {
  key: string;
  value: string;
};

type LearnedSection = {
  facts: Fact[];
  preferences: Preference[];
  personas: string[];
  summary: string;
};

export default pattern<
  { situation: string; context: { [id: string]: any } },
  WishState<Writable<any>>
>(({ situation, context }) => {
  // Get user profile/learned data from home pattern
  const learnedWish = wish<LearnedSection>({ query: "#learned" });

  // Build profile context string for the system prompt
  const profileContext = computed(() => {
    const learned = learnedWish.result;
    if (!learned) return "";

    const parts: string[] = [];

    // Add summary if available
    if (learned.summary) {
      parts.push(`User profile summary: ${learned.summary}`);
    }

    // Add personas
    if (learned.personas && learned.personas.length > 0) {
      parts.push(`User personas: ${learned.personas.join(", ")}`);
    }

    // Add key facts (high confidence only)
    const keyFacts = (learned.facts || [])
      .filter((f) => f.confidence >= 0.7)
      .map((f) => f.content);
    if (keyFacts.length > 0) {
      parts.push(`Known facts about user: ${keyFacts.join("; ")}`);
    }

    // Add preferences
    const prefs = (learned.preferences || [])
      .map((p) => `${p.key}: ${p.value}`);
    if (prefs.length > 0) {
      parts.push(`User preferences: ${prefs.join("; ")}`);
    }

    return parts.length > 0
      ? `\n\n--- User Context ---\n${parts.join("\n")}\n---`
      : "";
  });

  // Build system prompt with profile context
  const systemPrompt = computed(() => {
    const profile = profileContext;
    return `Find a useful pattern, run it, pass link to final result.${profile}

Use the user context above to personalize your suggestions when relevant.`;
  });

  const suggestion = generateObject({
    system: systemPrompt,
    prompt: situation,
    context,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
    },
    model: "anthropic:claude-haiku-4-5",
    schema: toSchema<{ cell: Writable<any> }>(),
  });

  const result = computed(() => suggestion.result?.cell);

  return {
    result,
    [UI]: (
      <ct-cell-context $cell={result}>
        {computed(() => result ?? "Searching...")}
      </ct-cell-context>
    ),
  };
});
