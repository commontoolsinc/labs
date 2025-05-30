import { h } from "@commontools/html";
import {
  derive,
  handler,
  JSONSchema,
  lift,
  llm,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "@commontools/builder";

// Email schema based on Gmail recipe
const EmailProperties = {
  id: {
    type: "string",
    title: "Email ID",
    description: "Unique identifier for the email",
  },
  threadId: {
    type: "string",
    title: "Thread ID",
    description: "Identifier for the email thread",
  },
  labelIds: {
    type: "array",
    items: { type: "string" },
    title: "Labels",
    description: "Gmail labels assigned to the email",
  },
  snippet: {
    type: "string",
    title: "Snippet",
    description: "Brief preview of the email content",
  },
  subject: {
    type: "string",
    title: "Subject",
    description: "Email subject line",
  },
  from: {
    type: "string",
    title: "From",
    description: "Sender's email address",
  },
  date: {
    type: "string",
    title: "Date",
    description: "Date and time when the email was sent",
  },
  to: {
    type: "string",
    title: "To",
    description: "Recipient's email address",
  },
  plainText: {
    type: "string",
    title: "Plain Text Content",
    description: "Email content in plain text format (often empty)",
  },
  htmlContent: {
    type: "string",
    title: "HTML Content",
    description: "Email content in HTML format",
  },
  markdownContent: {
    type: "string",
    title: "Markdown Content",
    description: "Email content converted to Markdown format",
  },
} as const satisfies JSONSchema;

const EmailSchema = {
  type: "object",
  properties: EmailProperties,
  required: Object.keys(EmailProperties),
} as const satisfies JSONSchema;

type Email = Schema<typeof EmailSchema>;

// Extend Email with summary property
interface SummarizedEmail extends Email {
  summary: string;
}

// Input Schema for Email Summarizer
const EmailSummarizerInputSchema = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        properties: EmailProperties,
      },
    },
    settings: {
      type: "object",
      properties: {
        summaryLength: {
          type: "string",
          enum: ["micro", "short", "medium", "long"],
          default: "medium",
          description: "Length of the summary",
        },
        includeTags: {
          type: "boolean",
          default: true,
          description: "Include tags in the summary",
        },
      },
      required: ["summaryLength", "includeTags"],
    },
  },
  required: ["emails", "settings"],
  description: "Email Summarizer",
} as const satisfies JSONSchema;

// Output schema - reference the original email rather than copying all properties
const ResultSchema = {
  type: "object",
  properties: {
    summarizedEmails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          email: EmailSchema, // Reference the complete email
          summary: {
            type: "string",
            title: "Summary",
            description: "AI-generated summary of the email",
          },
        },
        required: ["email", "summary"],
      },
    },
  },
} as const satisfies JSONSchema;

// Declare a handler for updating summary length using JSON schema
const updateSummaryLength = handler(
  // Input schema (what comes from the event)
  {
    type: "object",
    properties: {
      detail: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    },
  },
  // State schema (what's passed when instantiating the handler)
  {
    type: "object",
    properties: {
      summaryLength: {
        type: "string",
        asCell: true, // Mark as cell
      },
    },
    required: ["summaryLength"],
  },
  // Handler function with Cell-typed state
  ({ detail }, { summaryLength }) => {
    // Now summaryLength is a Cell instance
    summaryLength.set(detail?.value ?? "medium");
  },
);

// Declare a handler for updating includeTags setting using JSON schema
const updateIncludeTags = handler(
  // Input schema
  {
    type: "object",
    properties: {
      detail: {
        type: "object",
        properties: {
          checked: { type: "boolean" },
        },
      },
    },
  },
  // State schema
  {
    type: "object",
    properties: {
      includeTags: {
        type: "boolean",
        asCell: true, // Mark as cell
      },
    },
    required: ["includeTags"],
  },
  // Handler function
  ({ detail }, { includeTags }) => {
    // Now includeTags is a Cell instance
    includeTags.set(detail?.checked ?? true);
  },
);

const genPrompt = lift(
  ({ summaryLength, includeTags, email }: { summaryLength: string, includeTags: boolean, email: Email }) => {

    const lengthInstructions = `${
      summaryLength === "short"
        ? "in 1-2 sentences"
        : summaryLength === "long"
        ? "in 5-7 sentences"
        : "in 3-4 sentences"
    }`;

    const tagInstructions = `${
      includeTags
        ? "Include up to 3 relevant tags or keywords in the format #tag at the end of the summary."
        : ""
    }`;

    const systemPrompt = `
      You are an email assistant that creates concise, informative summaries.
      Focus on the main point, action items, and key details.
      Output should be ${lengthInstructions}.
      ${tagInstructions}
    `;

    const userPrompt = `Subject: ${email.subject}
From: ${email.from}
Date: ${email.date}

${email.markdownContent}`;


    return {
      system: systemPrompt,
      messages: [userPrompt],
    };
  },
);

// The main recipe
export default recipe(
  EmailSummarizerInputSchema,
  ResultSchema,
  ({ emails, settings }) => {
    // We'll use str template literals directly instead of helper functions

    // Directly map emails to summaries using proper reactive patterns
    // The framework will track which emails need to be processed
    const summarizedEmails = emails.map((email) => {
      // Create prompts using the str template literal for proper reactivity
      // This ensures the prompts update when settings change
      // Call LLM to generate summary
      const { result: summary } = llm(genPrompt({summaryLength: settings.summaryLength, includeTags: settings.includeTags, email}));

      // Return a simple object that references the original email
      // This preserves reactivity and is cleaner
      return {
        email,
        summary
      };
    });

    // Simple counts derived from the arrays
    const summarizedCount = derive(
      summarizedEmails,
      (emails) => emails.length,
    );

    const totalEmailCount = derive(
      emails,
      (emails) => emails.length,
    );

    // Instantiate handlers for the UI by passing cells
    // Now the handler receives the actual cell instances rather than values
    const summaryLengthHandler = updateSummaryLength({
      summaryLength: settings.summaryLength, // This is a cell reference
    });

    const includeTagsHandler = updateIncludeTags({
      includeTags: settings.includeTags, // This is a cell reference
    });

    // Recipe UI and exports
    return {
      [NAME]: str`Email Summarizer (${summarizedCount}/${totalEmailCount})`,
      [UI]: (
        <os-container>
          <h2>Email Summarizer</h2>

          <div>
            <span>Emails: {totalEmailCount}</span>
            <span>Summarized: {summarizedCount}</span>
          </div>

          <common-hstack gap="sm">
            <common-vstack gap="sm">
              <div>
                <label>Summary Length</label>
                <common-input
                  value={settings.summaryLength}
                  placeholder="medium"
                  oncommon-input={summaryLengthHandler}
                />
              </div>

              <div>
                <common-checkbox
                  checked={settings.includeTags}
                  oncommon-checked={includeTagsHandler}
                />
                <label>Include Tags</label>
              </div>
            </common-vstack>
          </common-hstack>

          <div>
            <table>
              <thead>
                <tr>
                  <th>DATE</th>
                  <th>FROM</th>
                  <th>SUBJECT</th>
                  <th>SUMMARY</th>
                </tr>
              </thead>
              <tbody>
                {summarizedEmails.map((item) => (
                  <tr>
                    <td>{item.email.date}</td>
                    <td>{item.email.from}</td>
                    <td>{item.email.subject}</td>
                    <td>{item.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </os-container>
      ),
      summarizedEmails,
    };
  },
);
