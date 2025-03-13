import { Cell, registerNewRecipe, tsToExports } from "@commontools/runner";
import { client as llm } from "@commontools/llm";
import {
  createJsonSchema,
  JSONSchema,
  JSONSchemaWritable,
} from "@commontools/builder";
import { Charm, CharmManager } from "./charm.ts";
import { buildFullRecipe, getIframeRecipe } from "./iframe/recipe.ts";
import { buildPrompt, RESPONSE_PREFILL } from "./iframe/prompt.ts";
import { injectUserCode } from "./iframe/static.ts";
import { isCell } from "@commontools/runner";

const genSrc = async ({
  src,
  spec,
  newSpec,
  schema,
  model,
}: {
  src?: string;
  spec?: string;
  newSpec: string;
  schema: JSONSchema;
  model?: string;
}) => {
  const request = buildPrompt({ src, spec, newSpec, schema, model });

  let response = await llm.sendRequest(request);

  // FIXME(ja): this is a hack to get the prefill to work
  if (!response.startsWith(RESPONSE_PREFILL)) {
    response = RESPONSE_PREFILL + response;
  }

  const source = injectUserCode(
    response.split(RESPONSE_PREFILL)[1].split("\n```")[0],
  );
  return source;
};

export async function iterate(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  spec: string,
  shiftKey: boolean,
  model?: string,
): Promise<Cell<Charm>> {
  const { iframe } = getIframeRecipe(charm);
  if (!iframe) {
    throw new Error("Cannot iterate on a non-iframe. Must extend instead.");
  }

  const newSpec = shiftKey ? iframe.spec + "\n" + spec : spec;

  const newIFrameSrc = await genSrc({
    src: iframe.src,
    spec: iframe.spec,
    newSpec,
    schema: iframe.argumentSchema,
    model: model,
  });

  return generateNewRecipeVersion(charmManager, charm, newIFrameSrc, newSpec);
}

export function extractTitle(src: string, defaultTitle: string): string {
  const htmlTitleMatch = src.match(/<title>(.*?)<\/title>/)?.[1];
  const jsTitleMatch = src.match(/const title = ['"](.*)['"];?/)?.[1];
  return htmlTitleMatch || jsTitleMatch || defaultTitle;
}

export const generateNewRecipeVersion = (
  charmManager: CharmManager,
  charm: Cell<Charm>,
  newIFrameSrc: string,
  newSpec: string,
) => {
  const { recipeId, iframe } = getIframeRecipe(charm);

  if (!recipeId || !iframe) {
    throw new Error("FIXME, no recipeId or iframe, what should we do?");
  }

  const name = extractTitle(newIFrameSrc, "<unknown>");
  const newRecipeSrc = buildFullRecipe({
    ...iframe,
    src: newIFrameSrc,
    spec: newSpec,
    name,
  });

  return compileAndRunRecipe(
    charmManager,
    newRecipeSrc,
    newSpec,
    charm.getSourceCell()?.key("argument"),
    recipeId ? [recipeId] : undefined,
  );
};

export async function castNewRecipe(
  charmManager: CharmManager,
  goal: string,
  data?: any,
): Promise<Cell<Charm>> {
  console.log("Processing goal:", goal);

  // First, extract any existing schema if we have data
  const existingSchema = createJsonSchema(data);

  // Phase 1: Generate spec/plan and schema based on goal and possibly existing schema
  const firstPhaseResult = await generateSpecAndSchema(goal, existingSchema);

  // Extract the results from the first phase
  const enhancedSpec = firstPhaseResult.spec;
  const title = firstPhaseResult.title;
  const description = firstPhaseResult.description;

  // Determine the final schema to use
  let schema;
  if (existingSchema) {
    // If we had an existing schema, enhance it with the new metadata
    schema = {
      ...existingSchema,
      title: title,
      description: description,
    };
  } else {
    // Otherwise use the generated schema
    schema = firstPhaseResult.schema;
  }

  console.log("schema", schema);

  // Phase 2: Generate UI code using the schema and enhanced spec
  const newIFrameSrc = await genSrc({
    newSpec: enhancedSpec,
    schema,
  });
  const name = extractTitle(newIFrameSrc, title); // Use the generated title as fallback
  const newRecipeSrc = buildFullRecipe({
    src: newIFrameSrc,
    spec: enhancedSpec, // Original goal
    enhancedSpec: enhancedSpec, // Store the detailed spec
    argumentSchema: schema,
    resultSchema: {},
    name,
  });

  return compileAndRunRecipe(charmManager, newRecipeSrc, goal, data);
}

// Helper function to generate spec, plan, and schema from a goal and optional existing schema
async function generateSpecAndSchema(
  goal: string,
  existingSchema?: JSONSchema,
): Promise<{
  spec: string;
  schema: JSONSchema;
  data?: any;
  title: string;
  description: string;
}> {
  // Import the LLM client
  const { client } = await import("@commontools/llm");

  // Choose the appropriate prompt based on whether we have an existing schema
  let systemPrompt, userContent;

  if (existingSchema) {
    // Prompt when we have an existing schema - focus on spec generation
    systemPrompt = `
You are an expert system designer that creates detailed specifications based on user goals and existing data schemas.

Given a user's feature or product goal and an existing data schema, you will:
1. Create a short title (2-5 words) that names the artifact
2. Create a one-sentence description in the format "A <artifact> to <goal>"
3. Create a detailed specification that expands on the user's goal
4. Generate a brief implementation plan

Your response must be structured as follows:

<title>
[Short title for the artifact, 2-5 words]
</title>

<description>
[One-sentence description in the format "A <artifact> to <goal>"]
</description>

<spec>
[Detailed specification that expands on the user's goal, taking into account the existing schema]
</spec>

<plan>
[Brief implementation plan based on the existing schema]
</plan>

GUIDELINES:
- The title should be concise and descriptive (e.g., "Task Manager", "Recipe Browser")
- The description should be a single sentence that clearly states what the artifact does
- The specification should take into account the structure and capabilities of the existing schema
- Focus on what functionality can be built with the given schema
`;

    userContent = `
Goal: ${goal}

Existing Schema:
\`\`\`json
${JSON.stringify(existingSchema, null, 2)}
\`\`\`

Based on this goal and the existing schema, please provide a title, description, detailed specification, and implementation plan.
`;
  } else {
    // Prompt when we need to generate a schema from scratch
    systemPrompt = `
You are an expert system designer that creates detailed specifications, implementation plans, and data schemas based on user goals.

Given a user's feature or product goal, you will:
1. Create a short title (2-5 words) that names the artifact
2. Create a one-sentence description in the format "A <artifact> to <goal>"
3. Create a detailed specification that expands on the user's goal
4. Generate a brief implementation plan
5. Design a JSON schema that represents the data model for this feature

Your response must be structured as follows:

<title>
[Short title for the artifact, 2-5 words]
</title>

<description>
[One-sentence description in the format "A <artifact> to <goal>"]
</description>

<spec>
[Detailed specification that expands on the user's goal]
</spec>

<plan>
[Brief implementation plan]
</plan>

<schema>
[JSON Schema in valid JSON format]
</schema>

<example_data>
[Optional: Example data that conforms to the schema, in valid JSON format]
</example_data>

SCHEMA GUIDELINES:
1. The schema MUST:
   - Include reasonable default values for ALL required fields
   - Include descriptive titles for every property and object
   - Include detailed descriptions for each property explaining its purpose and usage
   - Use appropriate types, formats, and constraints
   - Mark important fields as required
   
2. Property Details:
   - For each property, include a "title" that is a concise, human-readable label
   - For each property, include a "description" that explains its purpose, constraints, and usage
   - For each property, provide a sensible default value in the "default" field
   
3. Example:
\`\`\`json
{
  "type": "object",
  "title": "Task Item",
  "description": "Represents a single task in the task management system",
  "properties": {
    "id": {
      "type": "string",
      "title": "Task ID",
      "description": "Unique identifier for the task",
      "default": "task-1"
    },
    "title": {
      "type": "string",
      "title": "Task Title",
      "description": "Short, descriptive title of the task",
      "default": "Complete project report"
    },
    "completed": {
      "type": "boolean",
      "title": "Completion Status",
      "description": "Whether the task has been completed",
      "default": false
    },
    "priority": {
      "type": "string",
      "title": "Task Priority",
      "description": "The importance level of the task",
      "enum": ["low", "medium", "high"],
      "default": "medium"
    }
  },
  "required": ["id", "title"]
}
\`\`\`

OTHER GUIDELINES:
- The title should be concise and descriptive (e.g., "Task Manager", "Recipe Browser")
- The description should be a single sentence that clearly states what the artifact does
- The schema should be comprehensive but not overly complex
`;

    userContent = goal;
  }

  // Send the request to the LLM
  const response = await client.sendRequest({
    model: "anthropic:claude-3-7-sonnet-latest",
    system: systemPrompt,
    stream: false,
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  // Extract sections from the response
  const title = extractSection(response, "title") || "New Charm";
  const description = extractSection(response, "description") ||
    `A tool to ${goal}`;
  const spec = extractSection(response, "spec") || goal;
  const plan = extractSection(response, "plan");

  // If we have an existing schema, use it; otherwise parse the generated schema
  let schema: JSONSchemaWritable;
  let data;

  if (existingSchema) {
    // Use the existing schema, no need to parse one
    schema = { ...existingSchema };
  } else {
    // Parse the generated schema
    const schemaJson = extractSection(response, "schema");
    const exampleData = extractSection(response, "example_data");

    try {
      schema = schemaJson ? JSON.parse(schemaJson) : createJsonSchema({}, {});
    } catch (error) {
      console.error("Error parsing schema:", error);
      // Fallback to creating a schema from empty data
      schema = createJsonSchema({}, {});
    }

    // Parse example data if provided
    try {
      data = exampleData ? JSON.parse(exampleData) : undefined;
    } catch (error) {
      console.error("Error parsing example data:", error);
    }
  }

  // Add title and description to schema
  schema.title = title;
  schema.description = description;

  return {
    spec,
    schema,
    data,
    title,
    description,
  };
}

// Helper function to extract sections from LLM response
function extractSection(text: string, sectionName: string): string | null {
  const regex = new RegExp(`<${sectionName}>(.*?)</${sectionName}>`, "s");
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

export async function compileRecipe(
  recipeSrc: string,
  spec: string,
  parents?: string[],
) {
  const { exports, errors } = await tsToExports(recipeSrc);
  if (errors) {
    throw new Error("Compilation errors in recipe");
  }
  const recipe = exports.default;
  if (!recipe) {
    throw new Error("No default recipe found in the compiled exports.");
  }
  const parentsIds = parents?.map((id) => id.toString());
  registerNewRecipe(recipe, recipeSrc, spec, parentsIds);
  return recipe;
}

export async function compileAndRunRecipe(
  charmManager: CharmManager,
  recipeSrc: string,
  spec: string,
  runOptions: any,
  parents?: string[],
): Promise<Cell<Charm>> {
  const recipe = await compileRecipe(recipeSrc, spec, parents);
  if (!recipe) {
    throw new Error("Failed to compile recipe");
  }

  return charmManager.runPersistent(recipe, runOptions);
}
