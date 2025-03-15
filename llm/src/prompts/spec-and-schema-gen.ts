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

<argument_schema>
[Minimal JSON Schema in valid JSON format that represents the core data model]
</argument_schema>

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
You are an experienced software architect tasked with creating a simple Minimum Viable Product (MVP) based on a user's goal, using an existing data schema. Your focus should be on the simplest implementation that works with the provided schema.

Here is the existing schema:
<existing_schema>
{{existingSchema}}
</existing_schema>

Here is the user's goal:
<user_goal>
{{goal}}
</user_goal>

Your task is to create the following elements:

1. A short title (2-5 words) that names the artifact
2. A one-sentence description in the format "A <artifact> to <goal>"
3. A concise specification (3-5 sentences max) that works with the existing schema
4. A brief implementation plan (3 steps max)
5. A minimal JSON schema that represents the core data model

Before providing your final output, wrap your analysis inside <analysis> tags to consider the following points:
- List the key components of the user's goal
- Identify relevant parts of the existing schema for each component
- Consider potential simplifications for the MVP
- Determine the essential fields needed for the JSON schema (aim for 5-7 properties max)
- Analyze whether a copy of the input data is necessary or if it can be used directly, given that inputs are reactive and bidirectional

After your analysis, provide your output in the following format:

<title>
[Short title for the artifact, 2-5 words]
</title>

<description>
[One-sentence description in the format "A <artifact> to <goal>"]
</description>

<spec>
[Concise specification that captures only the essential requirements, 3-5 bullet points]
</spec>

<plan>
[Brief implementation plan, 3-5 bullet points]
</plan>

<additional_schema>
[Minimal JSON Schema in valid JSON format that represents data that is newly created by the artifact. Optional, only add if new data is created.]
</additional_schema>

Important guidelines:
- Aim for the simplest possible solution that works with the existing schema
- The specification should take into account the existing schema structure
- Focus on what can be achieved quickly with the existing data model
- Avoid suggesting modifications to the schema if possible
- Keep the JSON schema minimal, including only essential fields (5-7 properties max)
- Each property in the JSON schema should have a descriptive "title" field, a brief "description" field, and a sensible default value where appropriate
- Focus on capturing all the important state the user is creating, but aim for fewer fields rather than more

Remember, this is a first version, and the user can always iterate and improve the solution later.
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
  spec: string;
  plan: string;
  title: string;
  description: string;
  resultSchema: JSONSchema;
  argumentSchema: JSONSchema;
}> {
  let systemPrompt, userContent;

  if (existingSchema && Object.keys(existingSchema).length > 0) {
    // When we have an existing schema, focus on generating specification
    systemPrompt = "";
    userContent = hydratePrompt(SPEC_FROM_SCHEMA_PROMPT, {
      goal,
      existingSchema,
    });
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
  let resultSchema: JSONSchemaWritable;
  let argumentSchema: JSONSchemaWritable;

  try {
    const resultSchemaJson = parseTagFromResponse(
      response,
      "additional_schema",
    );
    resultSchema = resultSchemaJson ? JSON.parse(resultSchemaJson) : {};
  } catch (error) {
    console.warn("Error parsing schema:", error);
    // Fallback to an empty schema
    resultSchema = {};
  }

  try {
    const argumentSchemaJson = parseTagFromResponse(
      response,
      "argument_schema",
    );
    argumentSchema = argumentSchemaJson ? JSON.parse(argumentSchemaJson) : {};
  } catch (error) {
    console.warn("Error parsing schema:", error);
    // Fallback to an empty schema
    argumentSchema = {};
  }

  // Add title and description to schema
  argumentSchema.title = title;
  argumentSchema.description = description;

  return {
    spec,
    resultSchema,
    title,
    description,
    argumentSchema,
    plan,
  };
}
