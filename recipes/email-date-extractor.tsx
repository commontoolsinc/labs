import {
  h,
  derive,
  handler,
  ifElse,
  JSONSchema,
  lift,
  llm,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

// Reuse email schema from email-summarizer.tsx
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
} as const;

const EmailSchema = {
  type: "object",
  properties: EmailProperties,
  required: Object.keys(EmailProperties),
} as const satisfies JSONSchema;

// Define the date item schema
const DateItemSchema = {
  type: "object",
  properties: {
    dateText: {
      type: "string",
      title: "Date Text",
      description: "The raw date text found in the email",
    },
    normalizedDate: {
      type: "string",
      title: "Normalized Date",
      description: "The date in ISO format (YYYY-MM-DD)",
    },
    normalizedTime: {
      type: "string",
      title: "Normalized Time",
      description: "The time in 24-hour format (HH:MM) if available",
    },
    context: {
      type: "string",
      title: "Context",
      description: "Brief context around the date mention",
    },
    confidence: {
      type: "number",
      title: "Confidence",
      description: "Confidence score (0-1) that this is a relevant date",
    },
  },
  required: ["dateText", "normalizedDate", "context", "confidence"],
} as const satisfies JSONSchema;

// Input Schema for Email Date Extractor
const EmailDateExtractorInputSchema = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      items: EmailSchema,
    },
    settings: {
      type: "object",
      properties: {
        includeEmailDate: {
          type: "boolean",
          default: false,
          description: "Whether to include the email's sent date in results",
        },
        extractTimes: {
          type: "boolean",
          default: true,
          description: "Whether to extract time information along with dates",
        },
        contextLength: {
          type: "number",
          default: 100,
          description: "Length of context to include around each date mention",
        },
        minConfidence: {
          type: "number",
          default: 0.7,
          description: "Minimum confidence threshold for included dates (0-1)",
        },
      },
      default: {},
      required: [
        "includeEmailDate",
        "extractTimes",
        "contextLength",
        "minConfidence",
      ],
    },
  },
  required: ["emails", "settings"],
  description: "Email Date Extractor",
} as const satisfies JSONSchema;

// Output Schema
const ResultSchema = {
  type: "object",
  properties: {
    emailsWithDates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          email: EmailSchema,
          dates: {
            type: "array",
            items: DateItemSchema,
          },
        },
        required: ["email", "dates"],
      },
    },
    allDates: {
      type: "array",
      items: DateItemSchema,
    },
  },
  required: ["emailsWithDates", "allDates"],
} as const satisfies JSONSchema;

// Define a handler for updating the includeEmailDate setting
const updateIncludeEmailDate = handler(
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
  {
    type: "object",
    properties: {
      includeEmailDate: {
        type: "boolean",
        asCell: true,
      },
    },
    required: ["includeEmailDate"],
  },
  ({ detail }, { includeEmailDate }) => {
    includeEmailDate.set(detail?.checked ?? false);
  },
);

// Define a handler for updating the extractTimes setting
const updateExtractTimes = handler(
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
  {
    type: "object",
    properties: {
      extractTimes: {
        type: "boolean",
        asCell: true,
      },
    },
    required: ["extractTimes"],
  },
  ({ detail }, { extractTimes }) => {
    extractTimes.set(detail?.checked ?? true);
  },
);

// Handler for updating context length
const updateContextLength = handler(
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
  {
    type: "object",
    properties: {
      contextLength: {
        type: "number",
        asCell: true,
      },
    },
    required: ["contextLength"],
  },
  ({ detail }, { contextLength }) => {
    const value = parseInt(detail?.value ?? "100", 10);
    contextLength.set(isNaN(value) ? 100 : value);
  },
);

// Handler for updating confidence threshold
const updateMinConfidence = handler(
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
  {
    type: "object",
    properties: {
      minConfidence: {
        type: "number",
        asCell: true,
      },
    },
    required: ["minConfidence"],
  },
  ({ detail }, { minConfidence }) => {
    const value = parseFloat(detail?.value ?? "0.7");
    minConfidence.set(isNaN(value) ? 0.7 : Math.max(0, Math.min(1, value)));
  },
);

// Define a lifted function to extract content from email
const getEmailContent = lift(
  // Input schema
  {
    type: "object",
    properties: {
      email: EmailSchema,
    },
    required: ["email"],
  },
  // Output schema
  {
    type: "object",
    properties: {
      email: EmailSchema,
      content: { type: "string" },
      hasContent: { type: "boolean" },
    },
    required: ["email", "content", "hasContent"],
  },
  // Implementation
  ({ email }) => {
    const content = email.markdownContent || email.plainText || email.snippet ||
      "";
    return {
      email,
      content: content.trim() ? content : "",
      hasContent: content.trim().length > 0,
    };
  },
);

// The main recipe
export default recipe(
  EmailDateExtractorInputSchema,
  ResultSchema,
  ({ emails, settings }) => {
    // Process each email to extract dates
    const emailsWithDates = emails.map((email) => {
      // First get the email content
      const emailContent = getEmailContent({ email });

      // Create LLM prompt for date extraction using ifElse instead of ternary operators
      const timeInstruction = ifElse(
        settings.extractTimes,
        "If time is mentioned, include normalized time in 24-hour format (HH:MM)",
        "Ignore time information",
      );

      const timeField = ifElse(
        settings.extractTimes,
        `"normalizedTime": "14:30",`,
        "",
      );

      const dateInclusionInstruction = ifElse(
        settings.includeEmailDate,
        "Include the email's sent date if it's mentioned in the content.",
        "Do not include the email's sent date.",
      );

      const systemPrompt = str`
        You are a specialized date extraction assistant. Extract all dates mentioned in the email.
        For each date found:
        1. Extract the raw text of the date as mentioned
        2. Normalize to ISO format (YYYY-MM-DD)
        3. ${timeInstruction}
        4. Include a brief context snippet (${settings.contextLength} characters) around the date mention
        5. Assign a confidence score (0-1) that this is a relevant future date/deadline/appointment
        
        Return only JSON in this exact format:
        {
          "dates": [
            {
              "dateText": "next Monday",
              "normalizedDate": "2025-04-07",
              ${timeField}
              "context": "Let's meet next Monday to discuss the project timeline.",
              "confidence": 0.95
            },
            ...more dates
          ]
        }
        
        ${dateInclusionInstruction}
        Only include dates with confidence score >= ${settings.minConfidence}.
      `;

      const userPrompt = str`
        Subject: ${email.subject}
        Date: ${email.date}
        From: ${email.from}
        
        ${emailContent.content}
      `;

      // Call LLM to get structured data - no conditional check needed
      // The framework will handle empty content cases reactively
      const extractionResult = llm({
        system: systemPrompt,
        messages: [userPrompt],
        model: "google:gemini-2.5-flash",
        mode: "json",
      });

      // Return email with extracted dates
      // The framework will handle the async nature of the LLM result
      return {
        email: email,
        dates: derive(extractionResult, (result) => {
          try {
            // Handle possible null result during processing
            if (!result?.result) return [];

            // Parse the result as JSON
            const parsed = typeof result.result === "string"
              ? JSON.parse(result.result)
              : result.result;

            return parsed?.dates || [];
          } catch (e) {
            // Return empty array if parsing fails
            return [];
          }
        }),
      };
    });

    // Derive a flattened list of all dates across all emails
    const allDates = derive(
      emailsWithDates,
      (items) => {
        // Flatten all dates from all emails into a single array
        return items.flatMap((item) => item.dates || []);
      },
    );

    // Count of emails and dates
    const emailCount = derive(emails, (emails) => emails?.length);
    const dateCount = derive(allDates, (dates) => dates?.length);

    // Instantiate handlers
    const includeEmailDateHandler = updateIncludeEmailDate({
      includeEmailDate: settings.includeEmailDate,
    });

    const extractTimesHandler = updateExtractTimes({
      extractTimes: settings.extractTimes,
    });

    const contextLengthHandler = updateContextLength({
      contextLength: settings.contextLength,
    });

    const minConfidenceHandler = updateMinConfidence({
      minConfidence: settings.minConfidence,
    });

    // Return recipe results
    return {
      [NAME]:
        str`Email Date Extractor (${dateCount} dates from ${emailCount} emails)`,
      [UI]: (
        <os-container>
          <h2>Email Date Extractor</h2>

          <div>
            <span>Emails processed: {emailCount}</span>
            <span>Dates found: {dateCount}</span>
          </div>

          <common-hstack gap="md">
            <common-vstack gap="sm">
              <div>
                <input
                  type="checkbox"
                  checked={settings.includeEmailDate}
                  onChange={includeEmailDateHandler}
                />
                <label>Include email sent date</label>
              </div>

              <div>
                <input
                  type="checkbox"
                  checked={settings.extractTimes}
                  onChange={extractTimesHandler}
                />
                <label>Extract time information</label>
              </div>

              <div>
                <label>Context length</label>
                <input
                  type="number"
                  value={settings.contextLength}
                  onChange={contextLengthHandler}
                />
              </div>

              <div>
                <label>Min confidence (0-1)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={settings.minConfidence}
                  onChange={minConfidenceHandler}
                />
              </div>
            </common-vstack>
          </common-hstack>

          <div>
            <h3>All Extracted Dates</h3>
            <table>
              <thead>
                <tr>
                  <th>DATE TEXT</th>
                  <th>NORMALIZED</th>
                  {ifElse(settings.extractTimes, <th>TIME</th>, null)}
                  <th>CONTEXT</th>
                  <th>CONFIDENCE</th>
                  <th>EMAIL</th>
                </tr>
              </thead>
              <tbody>
                {allDates.map((date) => (
                  <tr>
                    <td>{date.dateText}</td>
                    <td>{date.normalizedDate}</td>
                    {ifElse(
                      settings.extractTimes,
                      <td>
                        {ifElse(date.normalizedTime, date.normalizedTime, "-")}
                      </td>,
                      null,
                    )}
                    <td>{date.context}</td>
                    <td>
                      {derive(
                        date,
                        (d) => ((d?.confidence ?? 0) * 100).toFixed(0),
                      )}%
                    </td>
                    <td>
                      {derive(emailsWithDates, (items) =>
                        items.find((e) => e.dates.includes(date))?.email
                          .subject ||
                        "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3>Dates by Email</h3>
            {derive(emailsWithDates, (items) =>
              items.filter((item) =>
                item.dates && item.dates.length > 0
              ))
              .map((item) => (
                <div>
                  <h4>{item.email.subject}</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>DATE TEXT</th>
                        <th>NORMALIZED</th>
                        {ifElse(settings.extractTimes, (<th>TIME</th>), null)}
                        <th>CONTEXT</th>
                        <th>CONFIDENCE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.dates.map((date) => (
                        <tr>
                          <td>{date.dateText}</td>
                          <td>{date.normalizedDate}</td>
                          {ifElse(
                            settings.extractTimes,
                            (<td>
                              {ifElse(
                                date.normalizedTime,
                                date.normalizedTime,
                                "-",
                              )}
                            </td>),
                            null,
                          )}
                          <td>{date.context}</td>
                          <td>
                            {derive(
                              date,
                              (d) => (d?.confidence ?? 0 * 100).toFixed(0),
                            )}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
          </div>
        </os-container>
      ),
      emailsWithDates,
      allDates,
    };
  },
);
