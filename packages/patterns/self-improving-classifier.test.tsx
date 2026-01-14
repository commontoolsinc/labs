/// <cts-enable />
/**
 * Test Pattern: Self-Improving Classifier
 *
 * Tests the tier-based auto-classification functionality:
 * - Auto-classification when tier 3-4 rules match
 * - Rule metric updates after classification
 *
 * Pattern under test: ./self-improving-classifier.tsx
 *
 * KNOWN ISSUE: This test currently fails with "Tried to access a reactive
 * reference outside a reactive context" when submitting items via the
 * exported Stream. The test was committed in a failing state and requires
 * investigation into how pattern testing interacts with handler-exported
 * Streams. The pattern itself works correctly when deployed and tested
 * manually via Playwright or CLI.
 */
import { action, Cell, computed, handler, pattern } from "commontools";
import SelfImprovingClassifier from "./self-improving-classifier.tsx";

// Handler to set up a tier 4 rule
const setupTier4Rule = handler<
  void,
  { rules: Cell<unknown[]> }
>((_event, { rules }) => {
  rules.set([{
    id: "rule1",
    name: "Invoice Pattern",
    targetField: "subject",
    pattern: "invoice|statement|payment due",
    caseInsensitive: true,
    predicts: true,
    precision: 0.95,
    recall: 0.8,
    tier: 4,
    evaluationCount: 50,
    truePositives: 40,
    falsePositives: 2,
    trueNegatives: 8,
    falseNegatives: 0,
    createdAt: Date.now(),
    isShared: false,
  }]);
});

// Handler to set classifier config
const setupConfig = handler<
  void,
  { config: Cell<unknown> }
>((_event, { config }) => {
  config.set({
    question: "Is this email a bill?",
    minExamplesForRules: 5,
    autoClassifyThreshold: 0.85,
    prefillThreshold: 0.7,
    suggestionThreshold: 0.5,
    harmAsymmetry: "equal",
    enableLLMFallback: true,
  });
});

// Handler to clear examples
const clearExamples = handler<
  void,
  { examples: Cell<unknown[]> }
>((_event, { examples }) => {
  examples.set([]);
});

export default pattern(() => {
  // 1. Instantiate the classifier with empty initial state
  const subject = SelfImprovingClassifier({
    config: Cell.of({
      question: "",
      minExamplesForRules: 5,
      autoClassifyThreshold: 0.85,
      prefillThreshold: 0.7,
      suggestionThreshold: 0.5,
      harmAsymmetry: "equal" as const,
      enableLLMFallback: true,
    }),
    examples: Cell.of([]),
    rules: Cell.of([]),
    pendingClassifications: Cell.of([]),
    currentItem: Cell.of(null),
  });

  // Bind setup handlers
  const action_setup_config = setupConfig({ config: subject.config });
  const action_setup_tier4_rule = setupTier4Rule({ rules: subject.rules });
  const action_clear_examples = clearExamples({ examples: subject.examples });

  // ============= TEST ACTIONS =============
  // Use action() to call .send() on the pattern's streams (now using handler-based streams)

  const action_submit_matching_item = action(() => {
    subject.submitItem.send({
      fields: {
        subject: "Your Invoice #12345",
        body: "Please pay by January 15th",
      },
    });
  });

  const action_submit_non_matching_item = action(() => {
    subject.submitItem.send({
      fields: {
        subject: "Hello from a friend",
        body: "Just wanted to say hi!",
      },
    });
  });

  const action_submit_second_matching_item = action(() => {
    subject.submitItem.send({
      fields: {
        subject: "Payment Statement December",
        body: "Your monthly statement is ready",
      },
    });
  });

  // ============= ASSERTIONS =============

  // Initial state assertions
  const assert_initial_examples_empty = computed(() => {
    return subject.examples.length === 0;
  });

  const assert_initial_rules_empty = computed(() => {
    return subject.rules.length === 0;
  });

  // After setup assertions
  const assert_config_set = computed(() => {
    return subject.config.question === "Is this email a bill?";
  });

  const assert_rule_added = computed(() => {
    return subject.rules.length === 1 &&
      subject.rules[0].name === "Invoice Pattern";
  });

  // After submitting matching item - check first example is auto-classified
  const assert_auto_classified = computed(() => {
    if (subject.examples.length === 0) return false;
    const example = subject.examples[0];
    return (
      example.decidedBy === "auto" &&
      example.label === true &&
      example.reasoning.includes("Tier 4")
    );
  });

  // Stats should reflect auto-classification
  const assert_stats_updated = computed(() => {
    return subject.stats.totalExamples === 1 &&
      subject.stats.autoClassified === 1;
  });

  // After clearing and submitting non-matching item
  // Non-matching items go to LLM path, not auto-classified
  // In test environment without LLM, examples should remain empty
  const assert_examples_still_empty_after_non_match = computed(() => {
    return subject.examples.length === 0;
  });

  // Store initial rule metrics for comparison via closure
  let capturedEvalCount = 0;
  let capturedTP = 0;

  const action_capture_initial_metrics = action(() => {
    if (subject.rules.length > 0) {
      capturedEvalCount = subject.rules[0].evaluationCount;
      capturedTP = subject.rules[0].truePositives;
    }
  });

  // After submitting second matching item, check metrics increased
  const assert_rule_metrics_updated = computed(() => {
    if (subject.rules.length === 0) return false;
    const rule = subject.rules[0];
    // After submission, both evaluation count and true positives should increase
    return (
      rule.evaluationCount > capturedEvalCount &&
      rule.truePositives > capturedTP
    );
  });

  // Return tests array using discriminated union format
  return {
    tests: [
      // Test 1: Initial state is empty
      { assertion: assert_initial_examples_empty },
      { assertion: assert_initial_rules_empty },

      // Test 2: Setup config and rule
      { action: action_setup_config },
      { assertion: assert_config_set },
      { action: action_setup_tier4_rule },
      { assertion: assert_rule_added },

      // Test 3: Auto-classification works for matching items
      { action: action_submit_matching_item },
      { assertion: assert_auto_classified },
      { assertion: assert_stats_updated },

      // Test 4: Non-matching items don't auto-classify
      { action: action_clear_examples },
      { action: action_submit_non_matching_item },
      { assertion: assert_examples_still_empty_after_non_match },

      // Test 5: Rule metrics update after auto-classification
      { action: action_clear_examples },
      { action: action_capture_initial_metrics },
      { action: action_submit_second_matching_item },
      { assertion: assert_rule_metrics_updated },
    ],
    // Expose subject for debugging when deployed as charm
    subject,
  };
});
