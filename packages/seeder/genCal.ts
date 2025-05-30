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

const sizes = ["short", "medium", "long", "very long"];

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

const exampleCal = {
  "id": "4fe142fkpc1t7d2ntcca2snbg4_20280803T190000Z",
  "summary": "In The Woods Biweekly Live conversation",
  "description":
    "We'll meet in the Discord video channel within the In The Woods server.\n\nThis is one of the unrecorded discussions.",
  "start": "2028-08-03T15:00:00-04:00",
  "end": "2028-08-03T16:00:00-04:00",
  "location": "",
  "eventType": "default",
  "hangoutLink": "",
  "attendees": [
    {
      "email": "anotherjesse@gmail.com",
      "self": true,
      "responseStatus": "needsAction",
    },
  ],
};

const calSchema: Schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    summary: { type: "string" },
    description: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    location: { type: "string" },
    eventType: { type: "string" },
    hangoutLink: { type: "string" },
    attendees: { type: "array", items: { type: "object" } },
  },
  required: [
    "id",
    "summary",
    "description",
    "start",
    "end",
    "location",
    "eventType",
    "hangoutLink",
    "attendees",
  ],
};

const genEvent = async () => {
  const from = names[Math.floor(Math.random() * names.length)];
  const to = me[Math.floor(Math.random() * me.length)];
  const randomSize = sizes[Math.floor(Math.random() * sizes.length)];
  const cal = await gen(
    `Generate an ${randomSize} calendar event from ${from} for sometime in the next 30 days. Make sure that ${to} is in the attendees array, along with other attendees if applicable. HangoutLink and Location can be an empty string.`,
    calSchema,
  ) as Record<string, any>;
  cal.id = crypto.randomUUID();
  return cal;
};

const generateEvents = async (count: number) => {
  const events = [];
  for (let i = 0; i < count; i++) {
    const event = await genEvent();
    console.log(event);
    events.push(event);
  }
  Deno.writeTextFileSync("events.json", JSON.stringify(events, null, 2));
  return events;
};

await generateEvents(100);
