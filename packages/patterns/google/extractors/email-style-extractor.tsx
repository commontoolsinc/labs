/// <cts-enable />
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
  UI,
  Writable,
} from "commontools";
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
  reanalyzeFlag.set(Date.now());
});

const updateWorkEmail = handler<
  { target: { value: string } },
  { workEmail: Writable<string> }
>(({ target }, { workEmail }) => {
  workEmail.set(target.value);
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
      prompt: analysisPrompt,
      schema: STYLE_SCHEMA,
      system:
        "You are an expert linguist analyzing email writing patterns. Extract consistent style patterns across all provided emails. Be specific and use examples from the actual text.",
      model: "anthropic:claude-sonnet-4-5",
    });

    // Track last saved result reference to avoid redundant writes
    let lastSavedResult: unknown = null;

    // Auto-save LLM result to persistent Writable
    const _autoSaveStyle = computed(() => {
      const result = styleResult.result;
      const isPending = styleResult.pending;

      if (!isPending && result && result !== lastSavedResult) {
        lastSavedResult = result;
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
        <ct-screen>
          <div slot="header">
            <ct-heading level={3}>Email Style Extractor</ct-heading>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth */}
              {authUI}

              {/* Work email input */}
              {ifElse(
                isReady,
                <div
                  style={{
                    padding: "12px 16px",
                    backgroundColor: "#f9fafb",
                    borderRadius: "8px",
                    border: "1px solid #e5e7eb",
                  }}
                >
                  <label
                    style={{
                      display: "block",
                      fontSize: "13px",
                      fontWeight: "600",
                      color: "#374151",
                      marginBottom: "6px",
                    }}
                  >
                    Work email to exclude (optional)
                  </label>
                  <input
                    type="email"
                    value={workEmail}
                    onChange={updateWorkEmail({ workEmail })}
                    placeholder="you@company.com"
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      border: "1px solid #d1d5db",
                      fontSize: "13px",
                    }}
                  />
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#9ca3af",
                      marginTop: "4px",
                    }}
                  >
                    Exclude work emails to focus on personal writing style
                  </div>
                </div>,
                null,
              )}

              {/* Analysis status */}
              {ifElse(
                isReady,
                <div
                  style={{
                    padding: "12px 16px",
                    backgroundColor: "#f9fafb",
                    borderRadius: "8px",
                    border: "1px solid #e5e7eb",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "8px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "13px",
                        color: "#6b7280",
                      }}
                    >
                      {derive(extractor.emailCount, (c) =>
                        c > 0
                          ? `${c} sent emails fetched`
                          : "Fetching sent emails...")}
                    </span>
                    <span
                      style={{
                        fontSize: "13px",
                        color: "#6b7280",
                        marginLeft: "auto",
                      }}
                    >
                      {ifElse(
                        isAnalyzing,
                        <span style={{ color: "#6366f1" }}>
                          Analyzing style...
                        </span>,
                        derive(analyzedAt, (ts) =>
                          ts
                            ? `Last analyzed: ${new Date(ts).toLocaleString()}`
                            : ""),
                      )}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                    }}
                  >
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
                        fontWeight: "500",
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
                        fontWeight: "500",
                      }}
                    >
                      Re-analyze Style
                    </button>
                  </div>
                </div>,
                null,
              )}

              {/* Not enough emails warning */}
              {ifElse(
                derive(
                  { count: extractor.emailCount, ready: isReady },
                  ({ count, ready }) =>
                    ready && count > 0 && count < 5,
                ),
                <div
                  style={{
                    padding: "12px 16px",
                    backgroundColor: "#fef3c7",
                    borderRadius: "8px",
                    border: "1px solid #f59e0b",
                    fontSize: "13px",
                    color: "#b45309",
                  }}
                >
                  Need at least 5 sent emails for style analysis. Found{" "}
                  {extractor.emailCount}.
                </div>,
                null,
              )}

              {/* Extracted style card */}
              {ifElse(
                hasStyle,
                <div
                  style={{
                    padding: "16px",
                    backgroundColor: "#ffffff",
                    borderRadius: "8px",
                    border: "1px solid #e5e7eb",
                  }}
                >
                  <div
                    style={{
                      fontWeight: "600",
                      fontSize: "15px",
                      color: "#111827",
                      marginBottom: "12px",
                    }}
                  >
                    Your Writing Style
                  </div>

                  {/* Summary */}
                  <div
                    style={{
                      padding: "10px 14px",
                      backgroundColor: "#eff6ff",
                      borderRadius: "6px",
                      fontSize: "13px",
                      color: "#1d4ed8",
                      marginBottom: "12px",
                      lineHeight: "1.5",
                    }}
                  >
                    {derive(style, (s) =>
                      s?.summary || "")}
                  </div>

                  {/* Style details grid */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "10px",
                    }}
                  >
                    {/* Tone */}
                    <div style={{ fontSize: "12px" }}>
                      <div
                        style={{
                          fontWeight: "600",
                          color: "#6b7280",
                          marginBottom: "2px",
                        }}
                      >
                        Tone
                      </div>
                      <div style={{ color: "#111827" }}>
                        {derive(style, (s) =>
                          s?.overallTone || "")}
                      </div>
                    </div>

                    {/* Formality */}
                    <div style={{ fontSize: "12px" }}>
                      <div
                        style={{
                          fontWeight: "600",
                          color: "#6b7280",
                          marginBottom: "2px",
                        }}
                      >
                        Formality
                      </div>
                      <div style={{ color: "#111827" }}>
                        {derive(style, (s) =>
                          s?.formalityLevel || "")}
                      </div>
                    </div>

                    {/* Sentence style */}
                    <div style={{ fontSize: "12px" }}>
                      <div
                        style={{
                          fontWeight: "600",
                          color: "#6b7280",
                          marginBottom: "2px",
                        }}
                      >
                        Sentence Style
                      </div>
                      <div style={{ color: "#111827" }}>
                        {derive(style, (s) =>
                          s?.sentenceStyle || "")}
                      </div>
                    </div>

                    {/* Punctuation */}
                    <div style={{ fontSize: "12px" }}>
                      <div
                        style={{
                          fontWeight: "600",
                          color: "#6b7280",
                          marginBottom: "2px",
                        }}
                      >
                        Punctuation
                      </div>
                      <div style={{ color: "#111827" }}>
                        {derive(style, (s) => s?.punctuationHabits || "")}
                      </div>
                    </div>

                    {/* Vocabulary */}
                    <div style={{ fontSize: "12px" }}>
                      <div
                        style={{
                          fontWeight: "600",
                          color: "#6b7280",
                          marginBottom: "2px",
                        }}
                      >
                        Vocabulary
                      </div>
                      <div style={{ color: "#111827" }}>
                        {derive(style, (s) => s?.vocabularyNotes || "")}
                      </div>
                    </div>

                    {/* Signature */}
                    <div style={{ fontSize: "12px" }}>
                      <div
                        style={{
                          fontWeight: "600",
                          color: "#6b7280",
                          marginBottom: "2px",
                        }}
                      >
                        Signature
                      </div>
                      <div style={{ color: "#111827" }}>
                        {derive(
                          savedStyle,
                          (s: EmailStyle | null) =>
                            s?.signatureBlock || "(none)",
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Greetings & Closings */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "10px",
                      marginTop: "12px",
                    }}
                  >
                    <div style={{ fontSize: "12px" }}>
                      <div
                        style={{
                          fontWeight: "600",
                          color: "#6b7280",
                          marginBottom: "4px",
                        }}
                      >
                        Greetings
                      </div>
                      {derive(style, (s) =>
                        (s?.greetingPatterns || []).map((g, i) => (
                          <span
                            key={i}
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              backgroundColor: "#dbeafe",
                              color: "#1d4ed8",
                              borderRadius: "12px",
                              fontSize: "11px",
                              marginRight: "4px",
                              marginBottom: "4px",
                            }}
                          >
                            {g}
                          </span>
                        )))}
                    </div>
                    <div style={{ fontSize: "12px" }}>
                      <div
                        style={{
                          fontWeight: "600",
                          color: "#6b7280",
                          marginBottom: "4px",
                        }}
                      >
                        Closings
                      </div>
                      {derive(style, (s) =>
                        (s?.closingPatterns || []).map((c, i) => (
                          <span
                            key={i}
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              backgroundColor: "#d1fae5",
                              color: "#059669",
                              borderRadius: "12px",
                              fontSize: "11px",
                              marginRight: "4px",
                              marginBottom: "4px",
                            }}
                          >
                            {c}
                          </span>
                        )))}
                    </div>
                  </div>

                  {/* Example phrases */}
                  <div style={{ marginTop: "12px" }}>
                    <div
                      style={{
                        fontWeight: "600",
                        color: "#6b7280",
                        fontSize: "12px",
                        marginBottom: "4px",
                      }}
                    >
                      Example Phrases
                    </div>
                    {derive(style, (s) =>
                      (s?.examplePhrases || []).map((phrase, i) => (
                        <div
                          key={i}
                          style={{
                            padding: "6px 10px",
                            backgroundColor: "#f3f4f6",
                            borderRadius: "4px",
                            fontSize: "12px",
                            color: "#374151",
                            marginBottom: "4px",
                            fontStyle: "italic",
                          }}
                        >
                          "{phrase}"
                        </div>
                      )))}
                  </div>

                  {/* Metadata */}
                  <div
                    style={{
                      marginTop: "12px",
                      paddingTop: "10px",
                      borderTop: "1px solid #e5e7eb",
                      fontSize: "11px",
                      color: "#9ca3af",
                      display: "flex",
                      gap: "16px",
                    }}
                  >
                    <span>
                      {derive(
                        analyzedCount,
                        (c) =>
                          `${c} emails analyzed`,
                      )}
                    </span>
                    <span>
                      {derive(analyzedAt, (ts) =>
                        ts ? `Last: ${new Date(ts).toLocaleString()}` : "")}
                    </span>
                  </div>
                </div>,
                null,
              )}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);
