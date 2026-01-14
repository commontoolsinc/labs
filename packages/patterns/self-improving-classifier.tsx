/// <cts-enable />
/**
 * Self-Improving Classifier
 *
 * A binary classifier that uses LLMs for judgment calls but progressively
 * crystallizes intelligence into efficient regex rules. Implements the
 * "self-hoisting feedback loop" pattern for compounding quality improvements.
 *
 * Key features:
 * - LLM classifies from the start, auto-accumulating examples
 * - User corrections are tracked specially for learning
 * - Regex rules with precision-weighted voting (Phase 2)
 * - LLM-generated rule suggestions (Phase 3)
 * - Per-rule confidence tiers (Phase 4)
 *
 * @tags #classifier #learning
 */
import {
  action,
  computed,
  type Default,
  equals,
  generateObject,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

// =============================================================================
// TYPES
// =============================================================================

/** Confidence tiers from the self-hoisting essay */
type Tier = 0 | 1 | 2 | 3 | 4;

/** Input to classify - generic key-value structure */
interface ClassifiableInput {
  id: string;
  receivedAt: number;
  fields: Record<string, string>;
}

/** Full audit trail for labeled examples */
interface LabeledExample {
  input: ClassifiableInput;
  label: boolean;
  decidedBy: "user" | "auto" | "suggestion-accepted";
  reasoning: string;
  confidence: number;
  labeledAt: number;
  wasCorrection: boolean;
  originalPrediction?: boolean;
  isInteresting: boolean;
  interestingReason?: string;
}

/** A regex-based classification rule */
interface ClassificationRule {
  id: string;
  name: string;
  targetField: string;
  pattern: string;
  caseInsensitive: boolean;
  predicts: boolean;
  precision: number;
  recall: number;
  tier: Tier;
  evaluationCount: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  createdAt: number;
  isShared: boolean;
  sharedFrom?: string;
}

/** User configuration */
interface ClassifierConfig {
  question: string;
  minExamplesForRules: number;
  autoClassifyThreshold: number;
  prefillThreshold: number;
  suggestionThreshold: number;
  harmAsymmetry: "fp" | "fn" | "equal";
  enableLLMFallback: boolean;
}

/** LLM classification response */
interface LLMClassificationResult {
  classification: boolean;
  confidence: number;
  reasoning: string;
}

/** Rule suggestion from LLM */
interface RuleSuggestion {
  name: string;
  targetField: string;
  pattern: string;
  predicts: boolean;
  reasoning: string;
}

/** Classification result for an item */
interface ClassificationResult {
  inputId: string;
  classification: boolean;
  confidence: number;
  reasoning: string;
  decidedBy: "rules" | "llm" | "user";
  matchedRules: string[];
}

/** Pending item awaiting user confirmation */
interface PendingClassification {
  input: ClassifiableInput;
  result: ClassificationResult;
}

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

const DEFAULT_CONFIG: ClassifierConfig = {
  question: "",
  minExamplesForRules: 5,
  autoClassifyThreshold: 0.85,
  prefillThreshold: 0.70,
  suggestionThreshold: 0.50,
  harmAsymmetry: "equal",
  enableLLMFallback: true,
};

// =============================================================================
// PATTERN INPUT/OUTPUT
// =============================================================================

interface ClassifierInput {
  config: Writable<Default<ClassifierConfig, typeof DEFAULT_CONFIG>>;
  examples: Writable<Default<LabeledExample[], []>>;
  rules: Writable<Default<ClassificationRule[], []>>;
  pendingClassifications: Writable<Default<PendingClassification[], []>>;
  // Item currently being classified by LLM
  currentItem: Writable<Default<ClassifiableInput | null, null>>;
}

interface ClassifierOutput {
  config: ClassifierConfig;
  examples: LabeledExample[];
  rules: ClassificationRule[];
  pendingClassifications: PendingClassification[];
  stats: {
    totalExamples: number;
    positiveExamples: number;
    negativeExamples: number;
    autoClassified: number;
    correctionRate: number;
    totalRules: number;
  };
  submitItem: Stream<{ fields: Record<string, string> }>;
  confirmClassification: Stream<{ inputId: string }>;
  correctClassification: Stream<
    { inputId: string; correctLabel: boolean; reasoning?: string }
  >;
  dismissClassification: Stream<{ inputId: string }>;
  addRule: Stream<RuleSuggestion>;
  removeRule: Stream<{ ruleId: string }>;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/** Generate a unique ID */
function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/** Compute statistics from examples */
const computeStats = lift((args: {
  examples: LabeledExample[];
  rules: ClassificationRule[];
}): {
  totalExamples: number;
  positiveExamples: number;
  negativeExamples: number;
  autoClassified: number;
  correctionRate: number;
  totalRules: number;
} => {
  const { examples, rules } = args;

  const positiveExamples = examples.filter((e) => e.label).length;
  const negativeExamples = examples.filter((e) => !e.label).length;
  const autoClassified = examples.filter((e) => e.decidedBy === "auto").length;
  const corrections = examples.filter((e) => e.wasCorrection).length;
  const correctionRate = autoClassified > 0 ? corrections / autoClassified : 0;

  return {
    totalExamples: examples.length,
    positiveExamples,
    negativeExamples,
    autoClassified,
    correctionRate,
    totalRules: rules.length,
  };
});

/**
 * Calculate F1 score for a rule based on its metrics
 * F1 = 2 * (precision * recall) / (precision + recall)
 */
function calculateF1(rule: ClassificationRule): number {
  const precision = rule.precision;
  const recall = rule.recall;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Determine what tier a rule should be at based on its metrics
 *
 * Tier thresholds (from self-hoisting essay):
 * - Tier 0: Silent (no predictions) - default
 * - Tier 1: Suggestions (user can accept) - F1 >= 0.5, 3+ evals
 * - Tier 2: Default (pre-filled) - F1 >= 0.7, 5+ evals
 * - Tier 3: Self-driving (auto with undo) - F1 >= 0.85, 10+ evals
 * - Tier 4: Automatic (fully auto) - F1 >= 0.95, 20+ evals
 */
function _calculateTier(rule: ClassificationRule): Tier {
  const f1 = calculateF1(rule);
  const evals = rule.evaluationCount;

  if (evals >= 20 && f1 >= 0.95) return 4;
  if (evals >= 10 && f1 >= 0.85) return 3;
  if (evals >= 5 && f1 >= 0.70) return 2;
  if (evals >= 3 && f1 >= 0.50) return 1;
  return 0;
}

/**
 * Get human-readable tier label
 */
function getTierLabel(tier: Tier): string {
  switch (tier) {
    case 0:
      return "Silent";
    case 1:
      return "Suggest";
    case 2:
      return "Default";
    case 3:
      return "Auto+Undo";
    case 4:
      return "Automatic";
  }
}

/**
 * Get tier badge color
 */
function getTierColor(tier: Tier): string {
  switch (tier) {
    case 0:
      return "var(--ct-color-gray-400)";
    case 1:
      return "var(--ct-color-info-500)";
    case 2:
      return "var(--ct-color-success-500)";
    case 3:
      return "var(--ct-color-warning-500)";
    case 4:
      return "var(--ct-color-error-500)";
  }
}

// =============================================================================
// MODULE-SCOPED LIFT FUNCTIONS FOR DISPLAYING DATA IN .map()
// =============================================================================

/** Get the key from a field entry (for display in JSX) */
const getFieldKey = lift((entry: { key: string; value: string }): string =>
  entry.key
);

/** Get the value from a field entry (for display in JSX) */
const getFieldValue = lift((entry: { key: string; value: string }): string =>
  entry.value
);

/** Remove a field from the newItemFields record */
const removeFieldHandler = handler<
  unknown,
  {
    entry: { key: string; value: string };
    newItemFields: Writable<Record<string, string>>;
  }
>((_event, { entry, newItemFields }) => {
  const current = newItemFields.get();
  const updated = { ...current };
  delete updated[entry.key];
  newItemFields.set(updated);
});

// =============================================================================
// MODULE-SCOPED HANDLERS FOR BUTTON CLICKS IN .map()
// These handlers receive the pending item as a parameter at render time (in reactive context)
// so they don't need to access reactive proxies in the callback.
// Uses equals() for idiomatic cell reference comparison.
// =============================================================================

/** Confirm a pending classification (user agrees with the prediction) */
const confirmPendingClassification = handler<
  unknown,
  {
    pending: PendingClassification;
    examples: Writable<LabeledExample[]>;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { pending, examples, pendingClassifications }) => {
  const pendingList = pendingClassifications.get();
  const idx = pendingList.findIndex((p) => equals(pending, p));
  if (idx < 0) return;

  const item = pendingList[idx];
  const result = item.result;

  const example: LabeledExample = {
    input: item.input,
    label: result.classification,
    decidedBy: "suggestion-accepted",
    reasoning: result.reasoning,
    confidence: result.confidence,
    labeledAt: Date.now(),
    wasCorrection: false,
    isInteresting: result.confidence < 0.7,
    interestingReason: result.confidence < 0.7
      ? "Low confidence, user confirmed"
      : undefined,
  };

  examples.push(example);
  pendingClassifications.set(
    pendingList.filter((p) => !equals(pending, p)),
  );
});

/** Correct a pending classification (user disagrees with the prediction) */
const correctPendingClassification = handler<
  unknown,
  {
    pending: PendingClassification;
    examples: Writable<LabeledExample[]>;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { pending, examples, pendingClassifications }) => {
  const pendingList = pendingClassifications.get();
  const idx = pendingList.findIndex((p) => equals(pending, p));
  if (idx < 0) return;

  const item = pendingList[idx];
  const correctLabel = !item.result.classification;

  const example: LabeledExample = {
    input: item.input,
    label: correctLabel,
    decidedBy: "user",
    reasoning: "User correction",
    confidence: 1.0,
    labeledAt: Date.now(),
    wasCorrection: true,
    originalPrediction: item.result.classification,
    isInteresting: true,
    interestingReason: "User corrected classification",
  };

  examples.push(example);
  pendingClassifications.set(
    pendingList.filter((p) => !equals(pending, p)),
  );
});

/** Dismiss a pending classification without recording it */
const dismissPendingClassification = handler<
  unknown,
  {
    pending: PendingClassification;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { pending, pendingClassifications }) => {
  const pendingList = pendingClassifications.get();
  pendingClassifications.set(
    pendingList.filter((p) => !equals(pending, p)),
  );
});

/** Remove a rule from the rules list */
const removeRuleHandler = handler<
  unknown,
  {
    rule: ClassificationRule;
    rules: Writable<ClassificationRule[]>;
  }
>((_event, { rule, rules }) => {
  const currentRules = rules.get();
  rules.set(currentRules.filter((r) => !equals(rule, r)));
});

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<ClassifierInput>(
  ({ config, examples, rules, pendingClassifications, currentItem }) => {
    // Local state for new item input - use Writable.of for bidirectional binding with $value
    const newItemFields = Writable.of<Record<string, string>>({});
    const newFieldKey = Writable.of("");
    const newFieldValue = Writable.of("");

    // Transform Record to array of {key, value} for reactive iteration
    // Use computed() instead of lift() to avoid closure limitations
    const newItemFieldEntries = computed(() => {
      const fields = newItemFields.get() ?? {};
      return Object.entries(fields).map(([key, value]) => ({ key, value }));
    });

    // Compute stats
    const stats = computeStats({ examples, rules });

    // ==========================================================================
    // ACTIONS (using action() for simpler closures)
    // ==========================================================================

    /** Submit a new item for classification */
    const submitItem = action((e: { fields: Record<string, string> }) => {
      // Spread fields to ensure we get a plain copy, not a reactive proxy
      const fieldsCopy = { ...e.fields };
      const input: ClassifiableInput = {
        id: generateId(),
        receivedAt: Date.now(),
        fields: fieldsCopy,
      };
      currentItem.set(input);
    });

    /** Confirm an LLM classification (user agrees) - for API use */
    const confirmClassification = action((e: { inputId: string }) => {
      const pending = pendingClassifications.get();
      const itemIndex = pending.findIndex((p) => p.input.id === e.inputId);
      if (itemIndex < 0) return;

      const item = pending[itemIndex];
      const result = item.result;

      const example: LabeledExample = {
        input: item.input,
        label: result.classification,
        decidedBy: "suggestion-accepted",
        reasoning: result.reasoning,
        confidence: result.confidence,
        labeledAt: Date.now(),
        wasCorrection: false,
        isInteresting: result.confidence < 0.7,
        interestingReason: result.confidence < 0.7
          ? "Low confidence, user confirmed"
          : undefined,
      };

      examples.push(example);
      pendingClassifications.set(
        pending.filter((p) => p.input.id !== e.inputId),
      );
    });

    /** Correct a classification (user disagrees) - for API use */
    const correctClassification = action(
      (e: { inputId: string; correctLabel: boolean; reasoning?: string }) => {
        const pending = pendingClassifications.get();
        const itemIndex = pending.findIndex((p) => p.input.id === e.inputId);
        if (itemIndex < 0) return;

        const item = pending[itemIndex];

        const example: LabeledExample = {
          input: item.input,
          label: e.correctLabel,
          decidedBy: "user",
          reasoning: e.reasoning || "User correction",
          confidence: 1.0,
          labeledAt: Date.now(),
          wasCorrection: true,
          originalPrediction: item.result.classification,
          isInteresting: true,
          interestingReason: "User corrected classification",
        };

        examples.push(example);
        pendingClassifications.set(
          pending.filter((p) => p.input.id !== e.inputId),
        );
      },
    );

    /** Dismiss a classification without recording it - for API use */
    const dismissClassification = action((e: { inputId: string }) => {
      const pending = pendingClassifications.get();
      pendingClassifications.set(
        pending.filter((p) => p.input.id !== e.inputId),
      );
    });

    /** Add a new rule */
    const addRule = action((e: RuleSuggestion) => {
      const newRule: ClassificationRule = {
        id: generateId(),
        name: e.name,
        targetField: e.targetField,
        pattern: e.pattern,
        caseInsensitive: true,
        predicts: e.predicts,
        precision: 0.5,
        recall: 0.5,
        tier: 0,
        evaluationCount: 0,
        truePositives: 0,
        falsePositives: 0,
        trueNegatives: 0,
        falseNegatives: 0,
        createdAt: Date.now(),
        isShared: false,
      };
      rules.push(newRule);
    });

    /** Remove a rule */
    const removeRule = action((e: { ruleId: string }) => {
      const current = rules.get();
      rules.set(current.filter((r) => r.id !== e.ruleId));
    });

    // ==========================================================================
    // UI HELPERS
    // ==========================================================================

    /** Add field to new item */
    const addFieldToNewItem = action(() => {
      const key = newFieldKey.get().trim();
      const value = newFieldValue.get().trim();
      if (key && value) {
        const current = newItemFields.get();
        newItemFields.set({ ...current, [key]: value });
        newFieldKey.set("");
        newFieldValue.set("");
      }
    });

    /** Submit the new item for classification */
    const submitNewItem = action(() => {
      const fields = newItemFields.get();
      if (Object.keys(fields).length > 0) {
        // Inline the submitItem logic to avoid action-calling-action issue
        const fieldsCopy = { ...fields };
        const input: ClassifiableInput = {
          id: generateId(),
          receivedAt: Date.now(),
          fields: fieldsCopy,
        };
        currentItem.set(input);
        newItemFields.set({});
      }
    });

    // ==========================================================================
    // LLM CLASSIFICATION
    // ==========================================================================

    // Build the classification prompt when there's a current item to classify
    const classificationPrompt = computed(() => {
      const item = currentItem.get();
      if (!item) return "";

      const question = config.get().question || "Is this a positive example?";
      const examplesList = examples.get();

      // Get recent examples for few-shot learning
      const recentPositive = examplesList.filter((e) => e.label).slice(-3);
      const recentNegative = examplesList.filter((e) => !e.label).slice(-3);

      let prompt = `Question: ${question}\n\n`;
      prompt += `Input to classify:\n${
        JSON.stringify(item.fields, null, 2)
      }\n\n`;

      if (recentPositive.length > 0 || recentNegative.length > 0) {
        prompt += "Examples for context:\n";
        if (recentPositive.length > 0) {
          prompt += "\nPositive examples (answer is YES):\n";
          for (const ex of recentPositive) {
            prompt += `- ${JSON.stringify(ex.input.fields)}\n`;
          }
        }
        if (recentNegative.length > 0) {
          prompt += "\nNegative examples (answer is NO):\n";
          for (const ex of recentNegative) {
            prompt += `- ${JSON.stringify(ex.input.fields)}\n`;
          }
        }
      }

      return prompt;
    });

    // LLM classification - only runs when there's a prompt
    const llmResult = generateObject<LLMClassificationResult>({
      prompt: classificationPrompt,
      system:
        `You are a precise classifier. Analyze the input and determine if it matches the question criteria.
Respond with:
- classification: true for YES, false for NO
- confidence: a number between 0 and 1 indicating your confidence
- reasoning: a brief explanation of why you classified it this way`,
      model: "anthropic:claude-sonnet-4-5",
    });

    // When LLM result arrives, move item from currentItem to pendingClassifications
    const processLLMResult = computed(() => {
      const item = currentItem.get();
      if (!item) return null;

      if (llmResult.pending || llmResult.error) return null;

      const llmResultValue = llmResult.result;
      if (!llmResultValue) return null;

      // Check if we already processed this item
      const pending = pendingClassifications.get();
      if (pending.some((p) => p.input.id === item.id)) return null;

      // Try rules first with precision-weighted voting
      const configVal = config.get();
      const rulesVal = rules.get();
      const matchedRules: string[] = [];

      // Collect all matching rules with their precision weights
      interface RuleVote {
        name: string;
        predicts: boolean;
        precision: number;
        tier: Tier;
      }
      const votes: RuleVote[] = [];

      for (const rule of rulesVal) {
        const fieldValue = item.fields[rule.targetField];
        if (!fieldValue) continue;

        try {
          const flags = rule.caseInsensitive ? "i" : "";
          const regex = new RegExp(rule.pattern, flags);
          if (regex.test(fieldValue)) {
            matchedRules.push(rule.name);
            votes.push({
              name: rule.name,
              predicts: rule.predicts,
              precision: rule.precision,
              tier: rule.tier,
            });
          }
        } catch {
          // Invalid regex, skip
        }
      }

      // Precision-weighted voting: sum up precision-weighted votes for YES vs NO
      let yesWeight = 0;
      let noWeight = 0;
      for (const vote of votes) {
        if (vote.predicts) {
          yesWeight += vote.precision;
        } else {
          noWeight += vote.precision;
        }
      }

      // Determine rules-based prediction
      let rulesPrediction: boolean | null = null;
      let rulesConfidence = 0;

      if (votes.length > 0) {
        const totalWeight = yesWeight + noWeight;
        if (yesWeight > noWeight) {
          rulesPrediction = true;
          rulesConfidence = totalWeight > 0 ? yesWeight / totalWeight : 0.5;
        } else if (noWeight > yesWeight) {
          rulesPrediction = false;
          rulesConfidence = totalWeight > 0 ? noWeight / totalWeight : 0.5;
        } else {
          // Tie - use the higher tier rule's prediction
          const highestTierVote = votes.reduce((a, b) =>
            a.tier > b.tier ? a : b
          );
          rulesPrediction = highestTierVote.predicts;
          rulesConfidence = 0.5;
        }
      }

      let classification: ClassificationResult;

      if (
        rulesPrediction !== null &&
        rulesConfidence >= (configVal.autoClassifyThreshold || 0.85)
      ) {
        classification = {
          inputId: item.id,
          classification: rulesPrediction,
          confidence: rulesConfidence,
          reasoning: `Rules matched: ${matchedRules.join(", ")}`,
          decidedBy: "rules",
          matchedRules,
        };
      } else {
        classification = {
          inputId: item.id,
          classification: llmResultValue.classification,
          confidence: llmResultValue.confidence,
          reasoning: llmResultValue.reasoning,
          decidedBy: "llm",
          matchedRules,
        };
      }

      // Add to pending and clear current
      // Deep clone to ensure no reactive proxies leak in
      const plainInput = JSON.parse(JSON.stringify(item));
      const plainResult = JSON.parse(JSON.stringify(classification));
      pendingClassifications.push({ input: plainInput, result: plainResult });
      currentItem.set(null);

      return classification;
    });

    // Force the computed to run by referencing it
    const _lastProcessed = processLLMResult;

    // ==========================================================================
    // PHASE 3: LLM RULE GENERATION
    // ==========================================================================

    // Local state for pending rule suggestions - use Writable.of for .set() calls
    const suggestedRules = Writable.of<RuleSuggestion[]>([]);

    // Build the rule generation prompt when conditions are met
    const ruleGenerationPrompt = computed(() => {
      const examplesList = examples.get();
      const configVal = config.get();

      // Only generate when we have enough examples
      if (examplesList.length < (configVal.minExamplesForRules || 5)) return "";

      // Check for errors/corrections that indicate room for improvement
      const corrections = examplesList.filter((e) => e.wasCorrection);
      const interestingExamples = examplesList.filter((e) => e.isInteresting);

      // Only suggest rules if we have at least some interesting examples
      if (corrections.length === 0 && interestingExamples.length < 2) return "";

      // Get field names from examples
      const allFields = new Set<string>();
      for (const ex of examplesList) {
        for (const key of Object.keys(ex.input.fields)) {
          allFields.add(key);
        }
      }

      const question = configVal.question || "Is this a positive example?";

      const positiveExamples = examplesList.filter((e) => e.label).slice(-5);
      const negativeExamples = examplesList.filter((e) => !e.label).slice(-5);

      let prompt =
        `You are analyzing classification examples to generate regex rules.

Question being classified: "${question}"

Available fields: ${Array.from(allFields).join(", ")}

Positive examples (label = YES):
${positiveExamples.map((e) => JSON.stringify(e.input.fields)).join("\n")}

Negative examples (label = NO):
${negativeExamples.map((e) => JSON.stringify(e.input.fields)).join("\n")}

`;

      if (corrections.length > 0) {
        prompt += `Recent corrections (initially misclassified):
${
          corrections.slice(-3).map((e) =>
            `- ${JSON.stringify(e.input.fields)} → was ${
              e.originalPrediction ? "YES" : "NO"
            }, correct: ${e.label ? "YES" : "NO"}`
          ).join("\n")
        }

`;
      }

      prompt +=
        `Generate 1-3 regex patterns that could help classify future inputs.
Each rule should:
1. Target a specific field
2. Use a simple regex pattern (avoid overly complex patterns)
3. Be specific enough to avoid false positives
4. Explain why this pattern indicates the classification`;

      return prompt;
    });

    // LLM rule generation - only runs when there's a prompt
    interface RuleSuggestionsResult {
      suggestions: RuleSuggestion[];
    }

    const ruleGenResult = generateObject<RuleSuggestionsResult>({
      prompt: ruleGenerationPrompt,
      system:
        `You are a pattern recognition expert. Analyze the examples and generate regex rules.
Each suggestion should have:
- name: a short descriptive name
- targetField: which field to match against
- pattern: a regex pattern (without delimiters)
- predicts: true for YES, false for NO
- reasoning: why this pattern indicates the classification`,
      model: "anthropic:claude-sonnet-4-5",
    });

    // Process rule suggestions when they arrive
    const processRuleSuggestions = computed(() => {
      if (ruleGenResult.pending || ruleGenResult.error) return null;

      const result = ruleGenResult.result;
      if (!result || !result.suggestions || result.suggestions.length === 0) {
        return null;
      }

      // Only process if we haven't already set these suggestions
      const current = suggestedRules.get();
      if (current.length > 0) return null;

      suggestedRules.set(result.suggestions);
      return result.suggestions;
    });

    // Force evaluation
    const _ruleSuggestions = processRuleSuggestions;

    /** Clear all suggestions (to request new ones) */
    const refreshSuggestions = action(() => {
      suggestedRules.set([]);
    });

    // Display name
    const displayName = computed(() => {
      const q = config.get().question;
      return q ? `Classifier: ${q}` : "Self-Improving Classifier";
    });

    // ==========================================================================
    // UI
    // ==========================================================================

    return {
      [NAME]: displayName,
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="2">
            <ct-heading level={4}>{displayName}</ct-heading>
            <ct-input
              value={computed(() => config.get().question)}
              placeholder="Enter your classification question (e.g., 'Is this email a bill?')"
              onct-input={(e: { detail?: { value?: string } }) => {
                const q = e.detail?.value || "";
                const current = config.get();
                config.set({ ...current, question: q });
              }}
            />
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="3" style="padding: 1rem;">
              {/* Stats Section */}
              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={5}>Statistics</ct-heading>
                  <ct-hstack gap="4" justify="around">
                    <ct-vstack gap="0" align="center">
                      <span style="font-size: 1.5rem; font-weight: 600;">
                        {stats.totalExamples}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                        Examples
                      </span>
                    </ct-vstack>
                    <ct-vstack gap="0" align="center">
                      <span style="font-size: 1.5rem; font-weight: 600;">
                        {stats.positiveExamples}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                        YES
                      </span>
                    </ct-vstack>
                    <ct-vstack gap="0" align="center">
                      <span style="font-size: 1.5rem; font-weight: 600;">
                        {stats.negativeExamples}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                        NO
                      </span>
                    </ct-vstack>
                    <ct-vstack gap="0" align="center">
                      <span style="font-size: 1.5rem; font-weight: 600;">
                        {stats.totalRules}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                        Rules
                      </span>
                    </ct-vstack>
                  </ct-hstack>
                  {ifElse(
                    computed(() => stats.autoClassified > 0),
                    <span style="font-size: 0.875rem; color: var(--ct-color-gray-500); text-align: center;">
                      Correction rate:{" "}
                      {computed(() => (stats.correctionRate * 100).toFixed(1))}%
                    </span>,
                    null,
                  )}
                </ct-vstack>
              </ct-card>

              {/* Submit New Item */}
              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={5}>
                    Submit Item for Classification
                  </ct-heading>

                  {/* Current fields - show empty message or field list */}
                  {ifElse(
                    computed(() =>
                      Object.keys(newItemFields.get()).length === 0
                    ),
                    <span style="color: var(--ct-color-gray-400); font-size: 0.875rem;">
                      No fields added yet
                    </span>,
                    <ct-vstack gap="1">
                      {newItemFieldEntries.map(
                        (entry: { key: string; value: string }) => (
                          <ct-hstack gap="2" align="center">
                            <span style="font-weight: 500; min-width: 80px;">
                              {getFieldKey(entry)}:
                            </span>
                            <span style="flex: 1; color: var(--ct-color-gray-600);">
                              {getFieldValue(entry)}
                            </span>
                            <ct-button
                              variant="ghost"
                              onClick={removeFieldHandler({
                                entry,
                                newItemFields,
                              })}
                            >
                              x
                            </ct-button>
                          </ct-hstack>
                        ),
                      )}
                    </ct-vstack>,
                  )}

                  {/* Add field */}
                  <ct-hstack gap="2">
                    <ct-input
                      $value={newFieldKey}
                      placeholder="Field name"
                      style="width: 120px;"
                    />
                    <ct-input
                      $value={newFieldValue}
                      placeholder="Field value"
                      style="flex: 1;"
                    />
                    <ct-button variant="secondary" onClick={addFieldToNewItem}>
                      Add
                    </ct-button>
                  </ct-hstack>

                  <ct-button
                    variant="primary"
                    disabled={computed(() =>
                      Object.keys(newItemFields.get()).length === 0
                    )}
                    onClick={submitNewItem}
                  >
                    Classify
                  </ct-button>
                </ct-vstack>
              </ct-card>

              {/* Currently classifying */}
              {ifElse(
                computed(() => currentItem.get() !== null),
                <ct-card style="border-left: 4px solid var(--ct-color-info-500);">
                  <ct-vstack gap="2">
                    <ct-hstack gap="2" align="center">
                      <ct-loader size="sm" />
                      <span style="font-weight: 500;">Classifying...</span>
                    </ct-hstack>
                    <pre style="font-size: 0.75rem; overflow: auto; max-height: 100px; margin: 0; background: var(--ct-color-gray-50); padding: 0.5rem; border-radius: 4px;">
                      {computed(() => JSON.stringify(currentItem.get()?.fields, null, 2))}
                    </pre>
                  </ct-vstack>
                </ct-card>,
                null,
              )}

              {/* Pending Classifications */}
              {ifElse(
                computed(() => pendingClassifications.get().length > 0),
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={5}>Awaiting Confirmation</ct-heading>
                    {pendingClassifications.map((pending) => (
                      <ct-card style="background: var(--ct-color-gray-50);">
                        <ct-vstack gap="2">
                          <pre style="font-size: 0.75rem; overflow: auto; max-height: 100px; margin: 0;">
                            {computed(() =>
                              JSON.stringify(pending.input.fields, null, 2)
                            )}
                          </pre>

                          <ct-hstack gap="2" align="center">
                            <span
                              style={{
                                fontWeight: "600",
                                color: ifElse(
                                  pending.result.classification,
                                  "var(--ct-color-success-600)",
                                  "var(--ct-color-error-600)",
                                ),
                              }}
                            >
                              {ifElse(
                                pending.result.classification,
                                "YES",
                                "NO",
                              )}
                            </span>
                            <span style="color: var(--ct-color-gray-500); font-size: 0.875rem;">
                              ({computed(() =>
                                (pending.result.confidence * 100).toFixed(0)
                              )}% confidence via {pending.result.decidedBy})
                            </span>
                          </ct-hstack>

                          <span style="font-size: 0.875rem; color: var(--ct-color-gray-600);">
                            {pending.result.reasoning}
                          </span>

                          <ct-hstack gap="2">
                            <ct-button
                              variant="primary"
                              onClick={confirmPendingClassification({
                                pending,
                                examples,
                                pendingClassifications,
                              })}
                            >
                              Confirm
                            </ct-button>
                            <ct-button
                              variant="secondary"
                              onClick={correctPendingClassification({
                                pending,
                                examples,
                                pendingClassifications,
                              })}
                            >
                              Actually {ifElse(
                                pending.result.classification,
                                "NO",
                                "YES",
                              )}
                            </ct-button>
                            <ct-button
                              variant="ghost"
                              onClick={dismissPendingClassification({
                                pending,
                                pendingClassifications,
                              })}
                            >
                              Dismiss
                            </ct-button>
                          </ct-hstack>
                        </ct-vstack>
                      </ct-card>
                    ))}
                  </ct-vstack>
                </ct-card>,
                null,
              )}

              {/* Rules Section */}
              {ifElse(
                computed(() => rules.get().length > 0),
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={5}>Classification Rules</ct-heading>
                    {rules.map((rule) => (
                      <ct-hstack
                        gap="2"
                        align="center"
                        style="padding: 0.5rem; background: var(--ct-color-gray-50); border-radius: 4px;"
                      >
                        {/* Tier badge */}
                        <span
                          style={{
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontSize: "0.625rem",
                            fontWeight: "600",
                            backgroundColor: computed(() =>
                              getTierColor(rule.tier)
                            ),
                            color: "white",
                            whiteSpace: "nowrap",
                          }}
                        >
                          T{rule.tier}
                        </span>
                        <ct-vstack gap="0" style="flex: 1;">
                          <span style="font-weight: 500;">{rule.name}</span>
                          <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                            {rule.targetField}: /{rule.pattern}/{ifElse(
                              rule.caseInsensitive,
                              "i",
                              "",
                            )} → {ifElse(rule.predicts, "YES", "NO")}
                          </span>
                          <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">
                            P:{" "}
                            {computed(() => (rule.precision * 100).toFixed(0))}%
                            | F1: {computed(() =>
                              (calculateF1(rule) * 100).toFixed(0)
                            )}% | {rule.evaluationCount} evals | {computed(() =>
                              getTierLabel(rule.tier)
                            )}
                          </span>
                        </ct-vstack>
                        <ct-button
                          variant="ghost"
                          onClick={removeRuleHandler({ rule, rules })}
                        >
                          x
                        </ct-button>
                      </ct-hstack>
                    ))}
                  </ct-vstack>
                </ct-card>,
                null,
              )}

              {/* Suggested Rules */}
              {ifElse(
                computed(() => suggestedRules.get().length > 0),
                <ct-card style="border-left: 4px solid var(--ct-color-success-500);">
                  <ct-vstack gap="2">
                    <ct-hstack gap="2" align="center" justify="between">
                      <ct-heading level={5}>Suggested Rules</ct-heading>
                      <ct-button variant="ghost" onClick={refreshSuggestions}>
                        Refresh
                      </ct-button>
                    </ct-hstack>
                    {computed(() =>
                      suggestedRules.get().map((suggestion, index) => (
                        <ct-card style="background: var(--ct-color-success-50);">
                          <ct-vstack gap="2">
                            <ct-vstack gap="0">
                              <span style="font-weight: 500;">
                                {suggestion.name}
                              </span>
                              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                                {suggestion.targetField}: /{suggestion.pattern}/
                                → {suggestion.predicts ? "YES" : "NO"}
                              </span>
                            </ct-vstack>
                            <span style="font-size: 0.875rem; color: var(--ct-color-gray-600);">
                              {suggestion.reasoning}
                            </span>
                            <ct-hstack gap="2">
                              <ct-button
                                variant="primary"
                                onClick={() => {
                                  const suggestions = suggestedRules.get();
                                  if (
                                    index < 0 || index >= suggestions.length
                                  ) {
                                    return;
                                  }

                                  const s = suggestions[index];
                                  // Add rule
                                  const newRule: ClassificationRule = {
                                    id: generateId(),
                                    name: s.name,
                                    targetField: s.targetField,
                                    pattern: s.pattern,
                                    caseInsensitive: true,
                                    predicts: s.predicts,
                                    precision: 0.5,
                                    recall: 0.5,
                                    tier: 0,
                                    evaluationCount: 0,
                                    truePositives: 0,
                                    falsePositives: 0,
                                    trueNegatives: 0,
                                    falseNegatives: 0,
                                    createdAt: Date.now(),
                                    isShared: false,
                                  };
                                  rules.push(newRule);

                                  // Remove from suggestions
                                  suggestedRules.set(
                                    suggestions.filter((_, i) =>
                                      i !== index
                                    ),
                                  );
                                }}
                              >
                                Accept
                              </ct-button>
                              <ct-button
                                variant="ghost"
                                onClick={() => {
                                  const suggestions = suggestedRules.get();
                                  suggestedRules.set(
                                    suggestions.filter((_, i) => i !== index),
                                  );
                                }}
                              >
                                Reject
                              </ct-button>
                            </ct-hstack>
                          </ct-vstack>
                        </ct-card>
                      ))
                    )}
                  </ct-vstack>
                </ct-card>,
                null,
              )}

              {/* Recent Examples */}
              {ifElse(
                computed(() => examples.get().length > 0),
                <details>
                  <summary style="cursor: pointer; padding: 0.5rem; color: var(--ct-color-gray-600);">
                    Recent Examples ({computed(() => examples.get().length)})
                  </summary>
                  <ct-vstack gap="1" style="margin-top: 0.5rem;">
                    {computed(() => [...examples.get()].reverse().slice(0, 10))
                      .map((example) => (
                        <ct-hstack
                          gap="2"
                          align="center"
                          style={{
                            padding: "0.5rem",
                            background: ifElse(
                              example.wasCorrection,
                              "var(--ct-color-warning-50)",
                              "var(--ct-color-gray-50)",
                            ),
                            borderRadius: "4px",
                            borderLeft: ifElse(
                              example.isInteresting,
                              "3px solid var(--ct-color-warning-400)",
                              "none",
                            ),
                          }}
                        >
                          <span
                            style={{
                              fontWeight: "600",
                              color: ifElse(
                                example.label,
                                "var(--ct-color-success-600)",
                                "var(--ct-color-error-600)",
                              ),
                            }}
                          >
                            {ifElse(example.label, "YES", "NO")}
                          </span>
                          <span style="flex: 1; font-size: 0.875rem; color: var(--ct-color-gray-600);">
                            {computed(() => {
                              const entries = Object.entries(
                                example.input.fields,
                              );
                              const first = entries[0];
                              return first
                                ? `${first[0]}: ${first[1].substring(0, 30)}...`
                                : "(empty)";
                            })}
                          </span>
                          <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">
                            {example.decidedBy}
                            {ifElse(example.wasCorrection, " (corrected)", "")}
                          </span>
                        </ct-hstack>
                      ))}
                  </ct-vstack>
                </details>,
                null,
              )}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      config,
      examples,
      rules,
      pendingClassifications,
      stats,
      submitItem,
      confirmClassification,
      correctClassification,
      dismissClassification,
      addRule,
      removeRule,
    };
  },
);
