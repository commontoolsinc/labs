import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { client } from "../client.ts";
import type { JSONSchema, JSONSchemaWritable } from "@commontools/builder";
import { WorkflowForm } from "@commontools/charm";
import { systemMdConcise } from "../../../charm/src/iframe/static.ts";
import { formatForm } from "./spec-and-schema-gen.ts";

// This is for the 'imagine-single-phase' workflow

// Prompt for generating schema and specification from a goal
export const SCHEMA_AND_CODE_FROM_GOAL_PROMPT = `
You are creating a simple minimal viable product (MVP) based on a user's goal. Focus on the simplest implementation that works.

Given a user's feature request, you will:
1. Create a short title (2-5 words) that names the artifact
2. Create a one-sentence description in the format "A <artifact> to <goal>"
3. Design a minimal JSON schema that represents the core data model
4. Generate the source code for the updated artifact as per guide (attached)

Your response must be structured as follows:

<title>
[Short title for the artifact, 2-5 words]
</title>

<description>
[One-sentence description in the format "A <artifact> to <goal>"]
</description>

<argument_schema>
[Minimal JSON Schema in valid JSON format that represents the core data model]
</argument_schema>

<example_data>
[Simple example data that conforms to the schema]
</example_data>

<source_code>
[Source code for the updated artifact]
</source_code>

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

${systemMdConcise}

IMPORTANT:
- Focus on the simplest working version
- Aim for fewer fields rather than more
- But still capture all the important state the user is creating
- Remember, the user can always iterate and improve the solution later
`;

// Prompt for generating specification from a goal and existing schema
export const CODE_FROM_SCHEMA_PROMPT = `
You are creating a simple MVP based on the user's goal, using an existing data schema. Focus on the simplest implementation that works with the provided schema.

Given a user's feature request and an existing data schema, you will:
1. Create a short title (2-5 words) that names the artifact
2. Create a one-sentence description in the format "A <artifact> to <goal>"
3. Design a minimal JSON schema that represents the core data model
4. Generate the source code for the updated artifact as per guide (attached)

Your response must be structured as follows:

<title>
[Short title for the artifact, 2-5 words]
</title>

<description>
[One-sentence description in the format "A <artifact> to <goal>"]
</description>

<result_schema>
[Minimal JSON Schema in valid JSON format that represents data created by the artifact]
</result_schema>

<source_code>
[Source code for the updated artifact]
</source_code>

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

${systemMdConcise}

GUIDELINES:
- Aim for the simplest possible solution that works with the existing schema
- The specification should take into account the existing schema structure
- Focus on what can be achieved quickly with the existing data model
- Avoid suggesting modifications to the schema if possible

IMPORTANT:
- Focus on the simplest working version
- Aim for fewer fields rather than more
- But still capture all the important state the user is creating
- The user can always iterate and improve the solution later

Return ONLY the requested XML tags, no other commentary.
`;

/**
 * Generates a schema and code from a goal.
 * @param goal The user's goal or request
 * @param existingSchema Optional existing schema to use as a basis
 * @param model Optional model identifier to use (defaults to claude-3-7-sonnet)
 * @returns Object containing title, description, specification, schema
 */
export async function generateCodeAndSchema(
  form: WorkflowForm,
  existingSchema?: JSONSchema,
  model: string = "anthropic:claude-3-7-sonnet-latest",
): Promise<{
  sourceCode: string;
  title: string;
  description: string;
  resultSchema: JSONSchema;
  argumentSchema: JSONSchema;
}> {
  let systemPrompt, userContent;
  if (!form.plan) {
    throw new Error("Plan is required");
  }

  if (existingSchema && Object.keys(existingSchema).length > 0) {
    // When we have an existing schema, focus on generating specification
    systemPrompt = CODE_FROM_SCHEMA_PROMPT;
    userContent = `
${formatForm(form)}

Existing Schema:
\`\`\`json
${JSON.stringify(existingSchema, null, 2)}
\`\`\`

Based on this goal and the existing schema, please provide a title, description, any additional schema and the source code.
`;
  } else {
    // When generating from scratch, use the full schema generation prompt
    systemPrompt = SCHEMA_AND_CODE_FROM_GOAL_PROMPT;
    userContent = formatForm(form);
  }

  // Send the request to the LLM using the specified model or default
  const response = await client.sendRequest({
    model: model,
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
  const description = parseTagFromResponse(response, "description");
  const sourceCode = parseTagFromResponse(response, "source_code");

  // If we have an existing schema, use it; otherwise parse the generated schema
  let resultSchema: JSONSchemaWritable;
  let argumentSchema: JSONSchemaWritable;

  try {
    const resultSchemaJson = parseTagFromResponse(response, "result_schema");
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
    sourceCode,
    resultSchema,
    title,
    description,
    argumentSchema,
  };
}
