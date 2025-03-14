import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { client } from "../client.ts";
import type { JSONSchema, JSONSchemaWritable } from "@commontools/builder";

// Prompt for generating schema and specification from a goal
export const SCHEMA_FROM_GOAL_PROMPT = `
You are creating a simple minimal viable product (MVP) based on a user's goal. Focus on the simplest implementation that works.

Given a user's feature request, you will:
1. Create a short title (2-5 words) that names the artifact
2. Create a one-sentence description in the format "A <artifact> to <goal>"
3. Create a concise specification (3-5 sentences max)
4. Generate a brief implementation plan (3 steps max)
5. Design a minimal JSON schema that represents the core data model

Your response must be structured as follows:

<title>
[Short title for the artifact, 2-5 words]
</title>

<description>
[One-sentence description in the format "A <artifact> to <goal>"]
</description>

<spec>
[Concise specification that captures only the essential requirements]
</spec>

<plan>
[Brief 3-step implementation plan]
</plan>

<schema>
[Minimal JSON Schema in valid JSON format]
</schema>

<example_data>
[Simple example data that conforms to the schema]
</example_data>

SCHEMA GUIDELINES:
1. Keep it minimal:
   - Include only essential fields (5-7 properties max)
   - Focus on the core functionality
   - If user requested complex features, simplify for this first version
   
2. Each property should have:
   - A descriptive "title" field
   - A brief "description" field
   - A sensible default value where appropriate
   
3. Example of a simple schema:
\`\`\`json
{
  "type": "object",
  "title": "Note",
  "description": "A simple note for the user",
  "properties": {
    "title": {
      "type": "string",
      "title": "Title",
      "description": "Title of the note",
      "default": "New Note"
    },
    "content": {
      "type": "string",
      "title": "Content",
      "description": "Content of the note"
    },
    "created": {
      "type": "string",
      "format": "date-time",
      "title": "Created Date",
      "description": "When the note was created",
    }
  },
  "required": ["title", "content"]
}
\`\`\`

IMPORTANT:
- Focus on the simplest working version
- Aim for fewer fields rather than more
- But still capture all the important state the user is creating
- Remember, the user can always iterate and improve the solution later
`;

// Prompt for generating specification from a goal and existing schema
export const SPEC_FROM_SCHEMA_PROMPT = `
You are creating a simple MVP based on the user's goal, using an existing data schema. Focus on the simplest implementation that works with the provided schema.

Given a user's feature request and an existing data schema, you will:
1. Create a short title (2-5 words) that names the artifact
2. Create a one-sentence description in the format "A <artifact> to <goal>"
3. Create a concise specification (3-5 sentences max) that works with the existing schema
4. Generate a brief implementation plan (3 steps max)

Your response must be structured as follows:

<title>
[Short title for the artifact, 2-5 words]
</title>

<description>
[One-sentence description in the format "A <artifact> to <goal>"]
</description>

<spec>
[Concise specification that captures only the essential requirements]
</spec>

<plan>
[Brief 3-step implementation plan using the existing schema]
</plan>

GUIDELINES:
- Aim for the simplest possible solution that works with the existing schema
- The specification should take into account the existing schema structure
- Focus on what can be achieved quickly with the existing data model
- Avoid suggesting modifications to the schema if possible

IMPORTANT:
- Focus on the simplest working version
- The user can always iterate and improve the solution later
`;

/**
 * Generates a complete specification, schema, and plan from a goal.
 * @param goal The user's goal or request
 * @param existingSchema Optional existing schema to use as a basis
 * @returns Object containing title, description, specification, schema
 */
export async function generateSpecAndSchema(
  goal: string,
  existingSchema?: JSONSchema,
): Promise<{
  title: string;
  description: string;
  spec: string;
  schema: JSONSchema;
}> {
  let systemPrompt, userContent;

  if (existingSchema) {
    // When we have an existing schema, focus on generating specification
    systemPrompt = SPEC_FROM_SCHEMA_PROMPT;
    userContent = `
Goal: ${goal}

Existing Schema:
\`\`\`json
${JSON.stringify(existingSchema, null, 2)}
\`\`\`

Based on this goal and the existing schema, please provide a title, description, detailed specification, and implementation plan.
`;
  } else {
    // When generating from scratch, use the full schema generation prompt
    systemPrompt = SCHEMA_FROM_GOAL_PROMPT;
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
  const title = parseTagFromResponse(response, "title") || "New Charm";
  const description = parseTagFromResponse(response, "description") ||
    `A tool to ${goal}`;
  const spec = parseTagFromResponse(response, "spec") || goal;
  const plan = parseTagFromResponse(response, "plan");

  // If we have an existing schema, use it; otherwise parse the generated schema
  let schema: JSONSchemaWritable;

  if (existingSchema) {
    // Use the existing schema, no need to parse one
    schema = { ...existingSchema };
  } else {
    // Parse the generated schema
    const schemaJson = parseTagFromResponse(response, "schema");
    const exampleData = parseTagFromResponse(response, "example_data");

    try {
      schema = schemaJson ? JSON.parse(schemaJson) : {};
    } catch (error) {
      console.error("Error parsing schema:", error);
      // Fallback to an empty schema
      schema = {};
    }
  }

  // Add title and description to schema
  schema.title = title;
  schema.description = description;

  return {
    title,
    description,
    spec,
    schema,
  };
}
