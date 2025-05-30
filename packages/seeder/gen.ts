import { generateObject as generateObjectCore, jsonSchema } from "ai";
import { openai } from "@ai-sdk/openai";

const model = openai("gpt-4.1-nano");

const names = [
  "John",
  "Jane",
  "Jim",
  "Jill",
  "Jack",
  "BestBuy",
  "Amazon",
  "Walmart",
  "Duke Hospital",
  "Mom",
];

const me = [
  "me@commontools.com",
  "awesomelist@commontools.com",
  "me+fam@commontools.com",
  "me+work@commontools.com",
];

const sizes = [
  "short",
  "medium",
  "long",
  "very long",
  "spam",
];

const writingStyles = [
  "rambling",
  "terse",
  "flowery",
  "technical",
  "poetic",
  "witty",
  "way TMI",
  "really angry",
  "passively aggressive",
  "dead inside",
];

type Schema = Record<string, any>;

const gen = async (prompt: string, schema: Schema) => {
  const { object } = await generateObjectCore({
    model: model,
    prompt: prompt,
    mode: "json",
    schema: jsonSchema(schema),
  });
  return object;
};

const emmailSchema: Schema = {
  type: "object",
  properties: {
    labelIds: { type: "array", items: { type: "string" } },
    snippet: { type: "string" },
    subject: { type: "string" },
    from: { type: "string" },
    date: { type: "string" },
    to: { type: "string" },
    plainText: { type: "string" },
    htmlContent: { type: "string" },
    markdownContent: { type: "string" },
  },
  required: [
    "labelIds",
    "snippet",
    "subject",
    "from",
    "date",
    "to",
    "plainText",
    "htmlContent",
    "markdownContent",
  ],
};

const genEmail = async () => {
  const to = me[Math.floor(Math.random() * me.length)];
  const from = names[Math.floor(Math.random() * names.length)];
  const randomSize = sizes[Math.floor(Math.random() * sizes.length)];
  const writingStyle =
    writingStyles[Math.floor(Math.random() * writingStyles.length)];
  const randomDate = new Date(
    Date.now() - Math.random() * 1000 * 60 * 60 * 24 * 7,
  );
  const email = await gen(
    `Generate an ${randomSize} ${writingStyle} email from ${from} to ${to} on ${randomDate.toISOString()}. Make sure the email has labels of INBOX and (READ or UNREAD). Plaintext doesn't have to be present / match the html/markdown content.`,
    emmailSchema,
  ) as Record<string, any>;
  email.id = crypto.randomUUID();
  email.threadId = crypto.randomUUID();
  return email;
};

const generateEmails = async (count: number) => {
  const emails = [];
  for (let i = 0; i < count; i++) {
    const email = await genEmail();
    console.log(email);
    emails.push(email);
  }
  Deno.writeTextFileSync("emails4.json", JSON.stringify(emails, null, 2));
  return emails;
};

const emails = await generateEmails(100);
