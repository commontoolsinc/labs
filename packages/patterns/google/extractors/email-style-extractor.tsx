/**
 * Email Style Extractor Pattern
 *
 * Fetches sent emails (from:me) and uses LLM to extract the user's personal
 * writing style. Exposes the result via #emailStyle wish tag so other patterns
 * (like expect-response-followup) can generate drafts that match the user's voice.
 *
 * Architecture:
 * - Uses GmailExtractor in raw mode (no extraction config) to fetch ~30 sent emails
 * - Runs a single generateObject call across all emails for cross-email style synthesis
 * - Persists result in a Writable so it survives across sessions
 *
 * Usage:
 * 1. Deploy this pattern
 * 2. Connect Google auth (gmail read-only scope)
 * 3. Optionally enter a work email to exclude work-related messages
 * 4. The pattern analyzes sent emails and exposes style data via #emailStyle
 */
import {
  computed,
  derive,
  generateObject,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  pattern,
  safeDateNow,
  UI,
  Writable,
} from "commonfabric";
import GmailExtractor from "../core/gmail-extractor.tsx";
import {
  createGoogleAuth,
  type ScopeKey,
} from "../core/util/google-auth-manager.tsx";

// =============================================================================
// TYPES
// =============================================================================

/** Extracted email writing style */
interface EmailStyle {
  overallTone: string;
  formalityLevel: string;
  greetingPatterns: string[];
  closingPatterns: string[];
  sentenceStyle: string;
  vocabularyNotes: string;
  signatureBlock: string;
  punctuationHabits: string;
  examplePhrases: string[];
  summary: string;
}

/** JSON Schema for the LLM extraction */
const STYLE_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    overallTone: {
      type: "string",
      description:
        'Overall tone of the writing, e.g. "casual and warm", "direct and professional"',
    },
    formalityLevel: {
      type: "string",
      enum: [
        "very formal",
        "formal",
        "neutral",
        "casual",
        "very casual",
      ],
      description: "Level of formality in writing",
    },
    greetingPatterns: {
      type: "array",
      items: { type: "string" },
      description:
        'Common greeting patterns, e.g. ["Hey", "Hi [name]", "Hello,"]',
    },
    closingPatterns: {
      type: "array",
      items: { type: "string" },
      description:
        'Common closing patterns, e.g. ["Best,", "Thanks!", "Cheers,"]',
    },
    sentenceStyle: {
      type: "string",
      description:
        'Description of sentence structure, e.g. "short and direct, uses fragments"',
    },
    vocabularyNotes: {
      type: "string",
      description:
        'Notes on vocabulary habits, e.g. "heavy use of contractions, casual language"',
    },
    signatureBlock: {
      type: "string",
      description:
        'Email signature if present, e.g. "-- Alex" or empty string if none',
    },
    punctuationHabits: {
      type: "string",
      description:
        'Punctuation tendencies, e.g. "liberal exclamation marks, em dashes"',
    },
    examplePhrases: {
      type: "array",
      items: { type: "string" },
      description: "3-5 characteristic phrases pulled from the emails",
    },
    summary: {
      type: "string",
      description: "2-3 sentence natural language summary of the writing style",
    },
  },
  required: [
    "overallTone",
    "formalityLevel",
    "greetingPatterns",
    "closingPatterns",
    "sentenceStyle",
    "vocabularyNotes",
    "signatureBlock",
    "punctuationHabits",
    "examplePhrases",
    "summary",
  ],
};

// =============================================================================
// HANDLERS
// =============================================================================

const triggerReanalyze = handler<
  unknown,
  { reanalyzeFlag: Writable<number> }
>((_event, { reanalyzeFlag }) => {
  reanalyzeFlag.set(safeDateNow());
});

// =============================================================================
// PATTERN
// =============================================================================

/** Personal email writing style extracted from sent emails. #emailStyle */
interface PatternOutput {
  style: EmailStyle | null;
  stylePrompt: string;
  emailsAnalyzed: number;
  lastAnalyzedAt: string;
  isAnalyzing: boolean;
}

export default pattern<Record<PropertyKey, never>, PatternOutput>(
  () => {
    // ========================================================================
    // STATE
    // ========================================================================

    const workEmail = Writable.of("").for("workEmail");
    const savedStyle = Writable.of<EmailStyle | null>(null).for("savedStyle");
    const lastAnalyzedAt = Writable.of("").for("lastAnalyzedAt");
    const emailsAnalyzedCount = Writable.of(0).for("emailsAnalyzedCount");
    const reanalyzeFlag = Writable.of(0).for("reanalyzeFlag");

    // ========================================================================
    // AUTH
    // ========================================================================

    const {
      auth,
      fullUI: authUI,
      isReady,
    } = createGoogleAuth({
      requiredScopes: ["gmail"] as ScopeKey[],
    });

    // ========================================================================
    // GMAIL QUERY
    // ========================================================================

    const gmailQuery = computed((): string => {
      const we = workEmail.get();
      let query = "from:me -to:me is:sent";
      if (we && we.trim()) {
        query += ` -to:${we.trim()}`;
      }
      return query;
    });

    // ========================================================================
    // GMAIL EXTRACTOR (raw mode)
    // ========================================================================

    const extractor = GmailExtractor({
      gmailQuery,
      limit: 30,
      overrideAuth: auth,
    });

    const allEmails = extractor.emails;

    // ========================================================================
    // LLM STYLE ANALYSIS
    // ========================================================================

    const analysisPrompt = computed((): string | undefined => {
      // Read reanalyzeFlag to allow re-triggering
      reanalyzeFlag.get();

      const emails = allEmails || [];
      if (emails.length < 5) return undefined;

      const snippets = emails
        .slice(0, 30)
        .map((email, i) => {
          const body = String(email.plainText || email.snippet || "");
          return `--- Email ${i + 1} ---\nTo: ${
            email.to || "unknown"
          }\nSubject: ${email.subject || "(no subject)"}\n\n${
            body.slice(0, 500)
          }`;
        })
        .join("\n\n");

      return `Analyze the following ${emails.length} sent emails from a single person and extract their personal writing style patterns. Focus on tone, formality, greetings, closings, sentence structure, vocabulary, punctuation habits, and signature. Pull out 3-5 actual characteristic phrases they use.

${snippets}

Extract the writing style patterns from these emails.`;
    });

    const styleResult = generateObject<EmailStyle>({
      prompt: analysisPrompt as any,
      schema: STYLE_SCHEMA,
      system:
        "You are an expert linguist analyzing email writing patterns. Extract consistent style patterns across all provided emails. Be specific and use examples from the actual text.",
      model: "anthropic:claude-sonnet-4-5",
    });

    // Auto-save LLM result to persistent Writable
    const _autoSaveStyle = computed(() => {
      const result = styleResult.result;
      const isPending = styleResult.pending;
      const currentSavedStyle = savedStyle.get();

      if (!isPending && result && result !== currentSavedStyle) {
        savedStyle.set(result as EmailStyle);
        const now = new Date().toISOString();
        lastAnalyzedAt.set(now);
        const emails = allEmails || [];
        emailsAnalyzedCount.set(Number(emails.length) || 0);
      }

      return null;
    });

    const isAnalyzing = computed(() => !!styleResult.pending);

    // Unwrap Writables once so derive calls in the UI get plain values.
    // The explicit param type is needed because derive infers Cell<T> for Writable<T>.
    const style = derive(
      savedStyle,
      (s: EmailStyle | null) => s,
    );
    const hasStyle = derive(style, (s) => !!s);
    const analyzedCount = derive(emailsAnalyzedCount, (c: number) => c);
    const analyzedAt = derive(lastAnalyzedAt, (ts: string) => ts);

    // Pre-built prompt string any consumer can drop into an LLM call
    const stylePrompt = derive(style, (s) => {
      if (!s?.summary) return "";
      const greetings = (s.greetingPatterns || []).join(", ");
      const closings = (s.closingPatterns || []).join(", ");
      const examples = (s.examplePhrases || []).join("; ");
      return `Writing style guidance:
- Tone: ${s.overallTone}
- Formality: ${s.formalityLevel}
- Greeting patterns: ${greetings}
- Closing patterns: ${closings}
- Sentence style: ${s.sentenceStyle}
- Punctuation habits: ${s.punctuationHabits}
- Vocabulary: ${s.vocabularyNotes}
- Signature: ${s.signatureBlock || "(none)"}
- Example phrases: ${examples}

Summary: ${s.summary}

Write as if the user wrote it themselves, matching their natural voice.`;
    });

    return {
      [NAME]: "Email Style Extractor",
      style,
      stylePrompt,
      emailsAnalyzed: emailsAnalyzedCount,
      lastAnalyzedAt,
      isAnalyzing,

      [UI]: (
        <cf-screen>
          <div slot="header">
            <cf-heading level={3}>Email Style Extractor</cf-heading>
          </div>
          <cf-vscroll flex showScrollbar>
            <cf-vstack padding="6" gap="4">
              {authUI}
              {ifElse(
                isReady,
                <div
                  style={{
                    padding: "8px",
                    backgroundColor: "#d1fae5",
                    borderRadius: "6px",
                  }}
                >
                  Auth ready. Emails: {derive(extractor.emailCount, (c) =>
                    c > 0 ? `${c} fetched` : "Fetching...")}
                </div>,
                <div
                  style={{
                    padding: "8px",
                    backgroundColor: "#fecaca",
                    borderRadius: "6px",
                  }}
                >
                  Waiting for Google auth...
                </div>,
              )}
              {ifElse(
                isAnalyzing,
                <div
                  style={{
                    padding: "8px",
                    backgroundColor: "#e0e7ff",
                    borderRadius: "6px",
                  }}
                >
                  Analyzing style...
                </div>,
                <div />,
              )}
              {ifElse(
                hasStyle,
                <div
                  style={{
                    padding: "12px",
                    backgroundColor: "#fff",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                  }}
                >
                  <div style={{ fontWeight: "600", marginBottom: "8px" }}>
                    Your Writing Style
                  </div>
                  <div style={{ marginBottom: "6px" }}>
                    {derive(style, (s) =>
                      s?.summary || "")}
                  </div>
                  <div style={{ fontSize: "12px", color: "#6b7280" }}>
                    Tone: {derive(style, (s) =>
                      s?.overallTone || "")} | Formality: {derive(style, (s) =>
                        s?.formalityLevel || "")}
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#9ca3af",
                      marginTop: "8px",
                    }}
                  >
                    {derive(analyzedCount, (c) => `${c} emails analyzed`)}{" "}
                    {derive(analyzedAt, (ts) =>
                      ts ? `| Last: ${new Date(ts).toLocaleString()}` : "")}
                  </div>
                </div>,
                <div style={{ padding: "8px", color: "#6b7280" }}>
                  No style extracted yet
                </div>,
              )}
              {ifElse(
                isReady,
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={extractor.refresh}
                    style={{
                      padding: "6px 12px",
                      backgroundColor: "#10b981",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontSize: "13px",
                    }}
                  >
                    Refresh Emails
                  </button>
                  <button
                    type="button"
                    onClick={triggerReanalyze({ reanalyzeFlag })}
                    style={{
                      padding: "6px 12px",
                      backgroundColor: "#6366f1",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontSize: "13px",
                    }}
                  >
                    Re-analyze
                  </button>
                </div>,
                <div />,
              )}
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
    };
  },
);
