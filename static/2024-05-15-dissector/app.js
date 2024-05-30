import Instructor from "https://cdn.jsdelivr.net/npm/@instructor-ai/instructor@1.2.1/+esm";
import cheerio from "https://cdn.jsdelivr.net/npm/cheerio@1.0.0-rc.12/+esm";
import OpenAI from "https://cdn.jsdelivr.net/npm/openai@4.40.1/+esm";
import TurndownService from "https://cdn.jsdelivr.net/npm/turndown@7.1.3/+esm";
import { z } from "https://cdn.jsdelivr.net/npm/zod@3.23.5/+esm";
import "./analysis-card.js";

let apiKey = localStorage.getItem("apiKey");

if (!apiKey) {
  // Prompt the user for the API key if it doesn't exist
  const userApiKey = prompt("Please enter your API key:");

  if (userApiKey) {
    // Save the API key in localStorage
    localStorage.setItem("apiKey", userApiKey);
    apiKey = userApiKey;
  } else {
    // Handle the case when the user cancels or doesn't provide an API key
    alert("API key not provided. Some features may not work.");
  }
}

const turndown = new TurndownService({ headingStyle: "atx" });
const urlInput = document.getElementById("url-input");
const fetchBtn = document.getElementById("fetch-btn");
const analyzeBtn = document.getElementById("analyze-btn");
const textArea = document.getElementById("text-area");
const characterCount = document.getElementById("character-count");

const feed = document.getElementById("feed");
const analysisQueue = [];
let inFlight = 0;
let complete = 0;
let lastAnalyzedLength = 0;
const WORD_THRESHOLD = 32;
const PAUSE_THRESHOLD = 1500; // 1.5 seconds
const MAX_CONCURRENT_ANALYSES = 3;

let targetDoc = "";

const openai = new OpenAI({
  apiKey: apiKey,
  dangerouslyAllowBrowser: true,
});

let model = "gpt-3.5-turbo";
// let model = "gpt-4-turbo-preview";
const client = Instructor({
  client: openai,
  mode: "JSON",
});

function createFactSchemaWithContext(dynamicContext) {
  return z.object({
    statement: z.string(),
    substring_quote: z
      .array(z.string())
      .transform((quotes) => {
        return quotes.flatMap((quote) => {
          const spans = getSpans(quote, dynamicContext);
          return spans.map((span) =>
            dynamicContext.substring(span[0], span[1])
          );
        });
      })
      .optional(),
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

function getSpans(quote, context) {
  const matches = [];
  // Example regex search for simplicity; adjust according to your actual implementation
  const regex = new RegExp(escapeRegExp(quote), "gi");
  let match;

  while ((match = regex.exec(context)) !== null) {
    matches.push([match.index, regex.lastIndex]);
  }
  return matches.length > 0 ? matches : [];
}

const QuestionAnswer = z.object({
  type: z.literal("QuestionAnswer"),
  question: z.string(),
  answer: z.array(
    z.object({
      statement: z.string(),
      substring_quote: z.array(z.string()), // Basic structure without dynamic context validation
    })
  ),
});

function createQuestionAnswerWithContext(dynamicContext) {
  const FactSchemaWithContext = createFactSchemaWithContext(dynamicContext);

  return z.object({
    type: z.literal("QuestionAnswer"),
    question: z.string(),
    answer: z.array(FactSchemaWithContext).transform((answers) => {
      // Filter out any Facts that, after validation, have no valid quotes
      return answers?.filter((fact) => fact.substring_quote?.length > 0);
    }),
  });
}

async function askAI(question, context) {
  const response = await client.chat.completions.create({
    model,
    response_model: { schema: QuestionAnswer, name: "Question and Answer" },
    messages: [
      {
        role: "system",
        content:
          "Scour the provided text to answer the attached question, provide exact quotations to support your answers.",
      },
      { role: "user", content: context },
      { role: "user", content: `Question: ${question}` },
    ],
  });
  const QuestionAnswerWithContext = createQuestionAnswerWithContext(context);
  const parsedResponse = QuestionAnswerWithContext.parse(response);

  return parsedResponse;
}

const AuthorSchema = z.object({
  type: z.literal("Author"),
  url: z.string().url().describe("The URL of the author's website"),
  name: z.string().describe("The name of the author"),
  occupation: z.string().describe("The occupation of the author"),
  employer: z.string().describe("The employer of the author"),
  age: z.number().describe("The age of the author"),
});

const DocumentSchema = z.object({
  type: z.literal("Document"),
  title: z.string(),
  keywords: z.array(z.string()),
  publishedAt: z.string().transform((date) => new Date(date)),
});

const SummarySchema = z.object({
  type: z.literal("Summary"),
  credibility: z.number(),
  readability: z.number(),
  sentiment: z.array(z.string()),
  executiveSummary: z.string().min(128).max(280),
});

const FivePointSummary = z.object({
  type: z.literal("FivePointSummary"),
  points: z.array(z.string().max(128)).length(5),
});

const ThreeMostImportantIdeas = z.object({
  type: z.literal("ThreeMostImportantIdeas"),
  ideas: z.array(z.string().max(128)).length(3),
});

const OpenQuestionsRaisedInText = z.object({
  type: z.literal("OpenQuestionsRaisedInText"),
  questions: z.array(z.string().max(128)).max(3),
});

const FriendlyAdviceForAuthor = z.object({
  type: z.literal("FriendlyAdviceForAuthor"),
  advice: z.string().max(255),
});

const FocalPoint = z.object({
  type: z.literal("FocalPoint"),
  me: z.number().describe("relative % of content related to the author"),
  others: z.number().describe("relative % of content related to other people"),
  objects: z.number().describe("relative % of content related to objects"),
});

const EmotionalDimensions = z.object({
  type: z.literal("EmotionalDimensions"),
  happy: z.number().describe("relative % of content related to happiness"),
  sad: z.number().describe("relative % of content related to sadness"),
  angry: z.number().describe("relative % of content related to anger"),
  surprised: z.number().describe("relative % of content related to surprise"),
  disgusted: z.number().describe("relative % of content related to disgust"),
  scared: z.number().describe("relative % of content related to fear"),
});

const MostCommonWords = z.object({
  type: z.literal("MostCommonWords"),
  words: z.array(z.string().max(128)).length(5),
});

const ReflectiveQuestions = z.object({
  type: z.literal("ReflectiveQuestions"),
  questions: z
    .array(z.string().max(128))
    .length(3)
    .describe(
      "3 reflective and inspiring questions you would ask the author to prompt further insight"
    ),
});

const TableOfContentsEntry = z.object({
  title: z.string(),
  level: z.number(),
  children: z.array(z.lazy(() => TableOfContentsEntry)),
});

const TableOfContents = z.object({
  type: z.literal("TableOfContents"),
  sections: z.array(TableOfContentsEntry),
});

const ConceptMapDiagram = z.object({
  type: z.literal("ConceptMapDiagram"),
  src: z
    .string()
    .describe(
      "mermaid diagram source code, with newlines, use unicode + short identifiers for all labels. begin with `graph LR;` or `graph TD;`"
    ),
});

const SocialMapDiagram = z.object({
  type: z.literal("SocialMapDiagram"),
  src: z
    .string()
    .describe(
      "mermaid diagram source code, with newlines, use unicode + short identifiers for all labels. begin with `graph LR;` or `graph TD;`"
    ),
});

const MetadataSchema = z.object({
  createdDate: z.string().describe("The date the knowledge graph was created"),
  lastUpdated: z
    .string()
    .describe("The date the knowledge graph was last updated"),
  description: z.string().describe("Description of the knowledge graph"),
});

const NodeDataSchema = z.object({
  id: z.string().describe("Unique identifier for the node"),
  label: z.string().describe("Label for the node"),
});

const EdgeDataSchema = z.object({
  id: z.string().optional().describe("Unique identifier for the edge"),
  source: z.string().describe("ID of the source node"),
  target: z.string().describe("ID of the target node"),
  relationship: z.string().describe("Type of relationship between the nodes"),
  direction: z.string().describe("Direction of the relationship"),
});

const CytoscapeElementsSchema = z.array(
  z.object({ data: z.union([NodeDataSchema, EdgeDataSchema]) })
);

const CytoscapeStyleSchema = z.object({
  selector: z.string().describe("CSS selector for the elements"),
  style: z.record(z.any()).describe("Style properties for the elements"),
});

const CytoscapeSchema = z.object({
  type: z.literal("KnowledgeGraph"),
  elements: CytoscapeElementsSchema.describe(
    "Elements (nodes and edges) in the graph"
  ),
})
  .describe(`Generate a Cytoscape.js compatible graph with entities and relationships.
Use the colors to help differentiate between different node or edge types/categories.
Always provide light pastel colors that work well with black font.`);

fetchBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (url !== "") {
    fetchWebpageContent(url);
  }
});

analyzeBtn.addEventListener("click", () => {
  const text = textArea.value.trim();
  if (text !== "") {
    targetDoc = text;
    analyzeText();
  }
});

textArea.addEventListener("input", () => {
  const text = textArea.value;
  characterCount.textContent = `${text.length} characters`;

  const words = text.trim().split(/\s+/);
  const newWords = words.length - lastAnalyzedLength;

  if (newWords >= WORD_THRESHOLD) {
    lastAnalyzedLength = words.length;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      analyzeText();
    }, PAUSE_THRESHOLD);
  }
});

async function fetchWebpageContent(url) {
  try {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);
    const textContent = $("body").html();
    targetDoc = turndown.turndown(textContent);
    textArea.value = targetDoc;
    characterCount.textContent = `${textContent.length} characters`;
    analyzeText();
  } catch (error) {
    console.error("Error fetching webpage content:", error);
  }
}

function clearAnalysis() {
  complete = 0;
  inFlight = 0;
  analysisQueue.length = 0;
  feed.innerHTML = "";
}

async function analyzeText() {
  try {
    const text = textArea.value;
    if (text === "") {
      return;
    }
    targetDoc = text;
    clearAnalysis();
    scheduleAnalysis();
  } catch (error) {
    console.error("Error analyzing text:", error);
  }
}

setInterval(checkAnalysisQueue, 250);
function checkAnalysisQueue() {
  if (inFlight >= MAX_CONCURRENT_ANALYSES) {
    return;
  }

  while (inFlight < MAX_CONCURRENT_ANALYSES && analysisQueue.length > 0) {
    const f = analysisQueue.shift();
    f();
  }
}

let timeoutId;
function scheduleAnalysis() {
  analysisQueue.push(() =>
    askQuestion(
      "What is a possible psychological profile of the author of this text? List their possible strengths, assumptions and blind spots."
    )
  );

  analysisQueue.push(() =>
    doAnalysis(
      SummarySchema,
      "Summary",
      true,
      "Generate a summary of the passed text. Include a credibility score, readability score, sentiment analysis, and an executive summary."
    )
  );
  analysisQueue.push(() =>
    doAnalysis(
      TableOfContents,
      "TableOfContents",
      true,
      "Generate a table of contents for the passed text. Use the headings and subheadings to create a nested structure, with each entry containing a title and a level."
    )
  );
  analysisQueue.push(() => doKnowledgeGraph());
  // analysisQueue.push(() => askQuestion("What is the main topic of this text?"));
  // analysisQueue.push(() =>
  //   doAnalysis(
  //     ConceptMapDiagram,
  //     "ConceptMap",
  //     false,
  //     "Generate mermaid diagram source code mapping the high-level concepts and principles of the passed text. Return only valid mermaid syntax, nothing else."
  //   )
  // );
  // analysisQueue.push(() =>
  //   doAnalysis(
  //     SocialMapDiagram,
  //     "SocialMap",
  //     false,
  //     "Generate mermaid diagram source code, with newlines, mapping all people and social relationships in the text. Return only valid mermaid syntax, nothing else."
  //   )
  // );
  // analysisQueue.push(() => doAnalysis(AuthorSchema, "Author"));
  // analysisQueue.push(() => doAnalysis(DocumentSchema, "Document"));
  // analysisQueue.push(() => doAnalysis(FivePointSummary, "FivePointSummary"));
  // analysisQueue.push(() => doAnalysis(FocalPoint, "FocalPoint"));
  // analysisQueue.push(() =>
  //   doAnalysis(EmotionalDimensions, "EmotionalDimensions")
  // );
  // analysisQueue.push(() => doAnalysis(MostCommonWords, "MostCommonWords"));
  // analysisQueue.push(() =>
  //   doAnalysis(ThreeMostImportantIdeas, "ThreeMostImportantIdeas")
  // );
  // analysisQueue.push(() =>
  //   doAnalysis(OpenQuestionsRaisedInText, "OpenQuestionsRaisedInText")
  // );
  // analysisQueue.push(() =>
  //   doAnalysis(ReflectiveQuestions, "ReflectiveQuestions")
  // );
  // analysisQueue.push(() =>
  //   doAnalysis(FriendlyAdviceForAuthor, "FriendlyAdviceForAuthor")
  // );
  updateQueueStatus();
}

async function doAnalysis(schema, name, stream = true, prompt) {
  inFlight++;
  updateQueueStatus();

  try {
    const extractionStream = await client.chat.completions.create({
      messages: [
        { role: "user", content: `<text>${targetDoc}</text>` },
        {
          role: "system",
          content:
            `Fill the provided schema using the above text.` + prompt
              ? `The user also made a request: <user-request>${prompt}</user-request>`
              : "",
        },
      ],
      model,
      response_model: {
        schema: schema,
        name: name,
      },
      stream,
    });

    const cardId = `card-${Date.now()}`;
    renderAnalysisCard(cardId);

    if (!stream) {
      const result = await extractionStream;
      updateAnalysisCard(cardId, result);
      return;
    }
    let extractedData = {};
    for await (const result of extractionStream) {
      extractedData = result;
      updateAnalysisCard(cardId, extractedData);
    }
  } catch (error) {
    console.error("Error analyzing text:", error);
  }

  inFlight--;
  complete++;
  updateQueueStatus();
}

async function doKnowledgeGraph() {
  inFlight++;
  updateQueueStatus();

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "user", content: `<text>${targetDoc}</text>` },
        {
          role: "system",
          content:
            "Analyze the above text for the purpose of creating a knowledge graph. Extract all key entities and relationships between them, including metaphorical and abstract relationships.",
        },
      ],
    });

    const extractionStream = await client.chat.completions.create({
      messages: [
        {
          role: "user",
          content: `<text>${targetDoc}</text>\n<analysis>${response.choices[0].message.content}</analysis>`,
        },
        {
          role: "system",
          content: `Based on the passed analysis and user input, create a knowledge graph with the following criteria:
          Nodes must have a label parameter. where the label is a concept from the input / analysis.
          Edges must also have a label parameter, wher the label is a concept from the input / analysis.
          Output all nodes first, based on the analysis, then add edges one by one between them.
          Pay close attention to the user's words and ensure all entities and relationships are accurately represented.
          Make sure the target and source of edges match an existing node.`,
        },
      ],
      model,
      response_model: {
        schema: CytoscapeSchema,
        name: "KnowledgeGraph",
      },
    });

    const cardId = `card-${Date.now()}`;
    renderAnalysisCard(cardId);

    const result = await extractionStream;
    updateAnalysisCard(cardId, result);
    return;
  } catch (error) {
    console.error("Error analyzing text:", error);
  }

  inFlight--;
  complete++;
  updateQueueStatus();
}

async function askQuestion(question) {
  inFlight++;
  updateQueueStatus();

  try {
    const data = await askAI(question, targetDoc);
    const cardId = `card-${Date.now()}`;
    renderAnalysisCard(cardId);

    let extractedData = {};
    updateAnalysisCard(cardId, data);
  } catch (error) {
    console.error("Error analyzing text:", error);
  }

  inFlight--;
  complete++;
  updateQueueStatus();
}

function renderAnalysisCard(cardId) {
  const card = document.createElement("analysis-card");
  card.id = cardId;
  feed.appendChild(card);
}

function updateAnalysisCard(cardId, analysis) {
  const card = document.getElementById(cardId);
  if (card) {
    card.analysis = analysis;
  }
}

const queueStatus = document.getElementById("queue-status");

function updateQueueStatus() {
  queueStatus.textContent = `${complete}/${complete + inFlight}`;
}

// renderAnalysisCard("test");
// updateAnalysisCard("test", {
//   type: "KnowledgeGraph",
//   elements: [
//     { data: { id: "startups", label: "Startups" } },
//     { data: { id: "easy_startups", label: "Easy Startups" } },
//     { data: { id: "hard_startups", label: "Hard Startups" } },
//     { data: { id: "instagram", label: "Instagram" } },
//     { data: { id: "photo_sharing_startups", label: "Photo Sharing Startups" } },
//     {
//       data: { id: "nuclear_fusion_startups", label: "Nuclear Fusion Startups" },
//     },
//     { data: { id: "talented_people", label: "Talented People" } },
//     { data: { id: "equity_grants", label: "Equity Grants" } },
//     { data: { id: "mission_of_the_company", label: "Mission of the Company" } },
//     {
//       data: {
//         id: "likelihood_of_massive_success",
//         label: "Likelihood of Massive Success",
//       },
//     },
//     { data: { id: "quality_of_people", label: "Quality of People" } },
//     { data: { id: "peter_principle", label: "Peter Principle" } },
//     { data: { id: "silicon_valley", label: "Silicon Valley" } },
//     { data: { id: "compounding_advantages", label: "Compounding Advantages" } },
//     {
//       data: {
//         id: "hard_requires_more",
//         source: "hard_startups",
//         target: "startups",
//         relationship: "require more resources",
//         direction: "from-to",
//       },
//     },
//     {
//       data: {
//         id: "instagram_example_of",
//         source: "instagram",
//         target: "photo_sharing_startups",
//         relationship: "is an example of",
//         direction: "from-to",
//       },
//     },
//     {
//       data: {
//         id: "photo_vs_nuclear",
//         source: "photo_sharing_startups",
//         target: "nuclear_fusion_startups",
//         relationship: "funded more than",
//         direction: "to-from",
//       },
//     },
//     {
//       data: {
//         id: "easy_difficulty",
//         source: "easy_startups",
//         target: "startups",
//         relationship: "easy to start, hard to succeed",
//         direction: "within",
//       },
//     },
//     {
//       data: {
//         id: "talent_attracted_by",
//         source: "talented_people",
//         target: "mission_of_the_company",
//         relationship: "attracted by",
//         direction: "to",
//       },
//     },
//     {
//       data: {
//         id: "equity_for_recruitment",
//         source: "equity_grants",
//         target: "mission_of_the_company",
//         relationship: "initial recruitment incentive",
//         direction: "to",
//       },
//     },
//     {
//       data: {
//         id: "peter_applies_to_startups",
//         source: "peter_principle",
//         target: "startups",
//         relationship: "applies metaphorically",
//         direction: "to",
//       },
//     },
//     {
//       data: {
//         id: "silicon_support",
//         source: "silicon_valley",
//         target: "ambitious_projects",
//         relationship: "supports",
//         direction: "from-to",
//       },
//     },
//     {
//       data: {
//         id: "long_term_vs_short_term",
//         source: "compounding_advantages",
//         target: "startups",
//         relationship: "favors long-term commitment",
//         direction: "to",
//       },
//     },
//   ],
//   _meta: {
//     usage: { prompt_tokens: 1686, completion_tokens: 951, total_tokens: 2637 },
//   },
// });
