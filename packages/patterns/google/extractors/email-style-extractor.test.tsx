/**
 * Test Pattern: EmailStyleExtractor
 *
 * Verifies the style extractor stays idle and explicit while waiting for auth.
 *
 * Run: deno task cf test packages/patterns/google/extractors/email-style-extractor.test.tsx --root packages/patterns --verbose
 */
import { assert, pattern, UI } from "commonfabric";
import { hasText } from "../../test/vnode-helpers.ts";
import EmailStyleExtractor from "./email-style-extractor.tsx";

export default pattern(() => {
  const extractor = EmailStyleExtractor({});

  const assert_initial_state_empty = assert(() =>
    extractor.style === null &&
    extractor.stylePrompt === "" &&
    extractor.emailsAnalyzed === 0 &&
    extractor.lastAnalyzedAt === "" &&
    extractor.isAnalyzing === false
  );

  const assert_waiting_for_auth = assert(() =>
    hasText(extractor[UI], "Waiting for Google auth...")
  );

  return {
    tests: [
      { assertion: assert_initial_state_empty },
      { assertion: assert_waiting_for_auth },
    ],
    extractor,
  };
});
