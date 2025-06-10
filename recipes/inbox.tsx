import { h } from "@commontools/html";
import {
  derive,
  JSONSchema,
  llm,
  NAME,
  recipe,
  str,
  UI,
} from "@commontools/builder/interface";

// Email properties matching the email-summarizer output
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

// Summarized email item schema
const SummarizedEmailSchema = {
  type: "object",
  properties: {
    email: EmailSchema,
    summary: {
      type: "string",
      title: "Summary",
      description: "AI-generated summary of the email",
    },
  },
  required: ["email", "summary"],
} as const satisfies JSONSchema;

// Input schema for the inbox recipe
const InboxInputSchema = {
  type: "object",
  properties: {
    summarizedEmails: {
      type: "array",
      items: SummarizedEmailSchema,
      title: "Summarized Emails",
      description: "Array of emails with their summaries",
    },
  },
  required: ["summarizedEmails"],
  description: "Smart Inbox with Priority Analysis",
} as const satisfies JSONSchema;

// Output schema
const InboxOutputSchema = {
  type: "object",
  properties: {
    headsUp: {
      type: "string",
      title: "Heads Up",
      description: "AI-generated priority analysis",
    },
    emailCount: {
      type: "number",
      title: "Email Count",
      description: "Total number of emails",
    },
  },
  required: ["headsUp", "emailCount"],
} as const satisfies JSONSchema;

// Helper to format date for display
const formatDate = (dateString: string): string => {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else {
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays}d ago`;
    }
  } catch {
    return dateString;
  }
};

// Helper to extract sender name
const getSenderName = (fromEmail: string): string => {
  const match = fromEmail.match(/^([^<]+)\s*</);
  if (match) {
    return match[1].trim();
  }
  const emailMatch = fromEmail.match(/^([^@]+)@/);
  return emailMatch ? emailMatch[1] : fromEmail;
};

// The main inbox recipe
export default recipe(
  InboxInputSchema,
  InboxOutputSchema,
  ({ summarizedEmails }) => {
    // Count total emails
    const emailCount = derive(
      summarizedEmails,
      (emails) => emails.length,
    );

    // System prompt for email analysis
    const systemPrompt = str`You are an intelligent email assistant. Analyze the provided email summaries and create a 2-3 sentence heads up about the most important or urgent items that need attention. Focus on deadlines, urgent requests, and important senders.`;

    // Generate email data for analysis
    const emailData = derive(
      summarizedEmails,
      (emails) => {
        if (emails.length === 0) {
          return "";
        }

        return emails.map((item, index) =>
          `${index + 1}. From: ${item.email.from}, Subject: ${item.email.subject}, Summary: ${item.summary}`
        ).join("\n");
      },
    );

    // Generate heads up using LLM
    const headsUpResult = llm({
      system: systemPrompt,
      messages: [emailData],
      enabled: derive(emailCount, (count) => count > 0),
    });

    // Extract the heads up text
    const headsUp = derive(
      [emailCount, headsUpResult.result],
      ([count, result]) => {
        if (count === 0) {
          return "No emails to analyze.";
        }
        return result || "Analyzing your inbox...";
      },
    );

    // Recipe UI and exports
    return {
      [NAME]: str`Smart Inbox (${emailCount} emails)`,
      [UI]: (
        <os-container>
          <h2>Smart Inbox</h2>

          {/* Heads up section */}
          <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
            <h3 style="margin: 0 0 8px 0; color: #856404;">
              📢 Heads Up
            </h3>
            <p style="margin: 0; color: #856404;">
              {headsUp}
            </p>
          </div>

          {/* Email table */}
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="border-bottom: 2px solid #e0e0e0;">
                <th style="padding: 12px; text-align: left;">FROM</th>
                <th style="padding: 12px; text-align: left;">SUBJECT</th>
                <th style="padding: 12px; text-align: left;">SUMMARY</th>
                <th style="padding: 12px; text-align: right;">TIME</th>
              </tr>
            </thead>
            <tbody>
              {summarizedEmails.map((item) => (
                <tr
                  key={item.email.id}
                  style="border-bottom: 1px solid #e0e0e0;"
                >
                  <td style="padding: 12px;">
                    {derive(item.email.from, getSenderName)}
                  </td>
                  <td style="padding: 12px;">
                    {item.email.subject}
                  </td>
                  <td style="padding: 12px; color: #666;">
                    {item.summary}
                  </td>
                  <td style="padding: 12px; text-align: right;">
                    {derive(item.email.date, formatDate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Empty state */}
          {derive(emailCount, (count) =>
            count === 0
              ? (
                <div style="text-align: center; padding: 40px; color: #666;">
                  <p>No emails to display</p>
                </div>
              )
              : null)}
        </os-container>
      ),
      headsUp,
      emailCount,
    };
  },
);
