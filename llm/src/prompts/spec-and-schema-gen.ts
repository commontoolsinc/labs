import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { client } from "../client.ts";
import type { JSONSchema, JSONSchemaWritable } from "@commontools/builder";

// Prompt for generating schema and specification from a goal
export const SCHEMA_FROM_GOAL_PROMPT = `
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

// Prompt for generating specification from a goal and existing schema
export const SPEC_FROM_SCHEMA_PROMPT = `
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

/**
 * Generates a complete specification, schema, and plan from a goal.
 * @param goal The user's goal or request
 * @param existingSchema Optional existing schema to use as a basis
 * @returns Object containing title, description, specification, schema, and optional data
 */
export async function generateSpecAndSchema(
  goal: string,
  existingSchema?: JSONSchema,
): Promise<{
  title: string;
  description: string;
  spec: string;
  schema: JSONSchema;
  data?: any;
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
  let data;

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
    title,
    description,
    spec,
    schema,
    data,
  };
}
