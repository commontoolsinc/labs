import { hydratePrompt, llmPrompt, parseTagFromResponse } from "./prompting.ts";
import { LLMClient } from "../client.ts";
import { DEFAULT_MODEL_NAME, extractTextFromLLMResponse } from "../types.ts";
import type { JSONSchema, JSONSchemaMutable } from "@commontools/runner";
import { WorkflowForm } from "@commontools/charm";

// Prompt for generating schema and specification from a goal
export const SCHEMA_FROM_GOAL_PROMPT = llmPrompt(
  "schema-from-goal",
  `
You are creating a simple minimal viable product (MVP) based on a user's goal. Focus on the simplest implementation that works.

<task>
Given a user's feature request, you will:
1. Create a short title (2-5 words) that names the artifact
2. Create a one-sentence description in the format "A <artifact> to <goal>"
3. Create a concise specification (3-5 sentences max)
4. Generate a brief implementation plan (3 steps max)
5. Design a minimal JSON schema that represents the core data model
</task>

<output_structure>
Your response must be structured as follows:

<thinking>Freeform reasoning for you to consider the solution.</thinking>

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
</output_structure>

<schema_guidelines>
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
  "title": "Note List",
  "description": "A simple note list for the user",
  "properties": {
    "notes": {
      "type": "array",
      "title": "Notes",
      "description": "List of user notes",
      "default": [],
      "items": {
        "type": "object",
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
            "description": "When the note was created"
          }
        },
        "required": ["title", "content"]
      }
    }
  },
  "required": ["title", "content"]
}
\`\`\`
</schema_guidelines>

IMPORTANT:
- Focus on the simplest working version
- Aim for fewer fields rather than more
- But still capture all the important state the user is creating
- Remember, the user can always iterate and improve the solution later
`,
);

// Prompt for generating specification from a goal and existing schema
export const SPEC_FROM_SCHEMA_PROMPT = llmPrompt(
  "spec-from-schema",
  `
You are creating a simple MVP based on the user's goal, using an existing data schema. Focus on the simplest implementation that works with the provided schema.

<task>
Given a user's feature request and an existing data schema, you will:
1. Create a short title (2-5 words) that names the artifact
2. Create a one-sentence description in the format "A <artifact> to <goal>"
3. Create a concise specification (3-5 sentences max) that works with the existing schema
4. Generate a brief implementation plan (3 steps max)
5. Design a minimal JSON schema that represents the core data model
</task>

<output_structure>
Your response must be structured as follows:

<thinking>Freeform reasoning for you to consider the solution.</thinking>

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

<result_schema>
[Minimal JSON Schema in valid JSON format that represents data created by the artifact]
</result_schema>
</output_structure>

<schema_guidelines>
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
  "title": "Note List",
  "description": "A simple note list for the user",
  "properties": {
    "notes": {
      "type": "array",
      "title": "Notes",
      "description": "List of user notes",
      "default": [],
      "items": {
        "type": "object",
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
            "description": "When the note was created"
          }
        },
        "required": ["title", "content"]
      }
    }
  },
  "required": ["title", "content"]
}
\`\`\`

GUIDELINES:
- Aim for the simplest possible solution that works with the existing schema
- The specification should take into account the existing schema structure
- Focus on what can be achieved quickly with the existing data model
- Avoid suggesting modifications to the schema if possible
</schema_guidelines>

<high_level>
IMPORTANT:
- Focus on the simplest working version
- Aim for fewer fields rather than more
- But still capture all the important state the user is creating
- The user can always iterate and improve the solution later
</high_level>
`,
);

export function formatForm(form: WorkflowForm) {
  return `
<goal>${form.input.processedInput}</goal>
${
    form.plan?.features?.length
      ? `<features>${
        form.plan.features.map((step) => `<feature>${step}</feature>`).join(
          "\n",
        )
      }</features>`
      : ""
  }
<description>${form.plan?.description}</description>
`;
}

/**
 * Generates a complete specification, schema, and plan from a goal.
 * @param goal The user's goal or request
 * @param existingSchema Optional existing schema to use as a basis
 * @param model Optional model identifier to use (defaults to claude-3-7-sonnet)
 * @returns Object containing title, description, specification, schema
 */
export async function generateSpecAndSchema(
  form: WorkflowForm,
  existingSchema?: JSONSchema,
  model: string = "anthropic:claude-sonnet-4-0",
): Promise<{
  spec: string;
  plan: string;
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
    systemPrompt = SPEC_FROM_SCHEMA_PROMPT;
    userContent = hydratePrompt(
      llmPrompt(
        "spec-from-schema-user",
        `
<user_input>
{{FORM}}
</user_input>

<existing_schema>
\`\`\`json
{{EXISTING_SCHEMA}}
\`\`\`
</existing_schema>

Based on this goal and the existing schema, please provide a title, description, any additional schema, detailed specification, and implementation plan.
`,
      ),
      {
        FORM: formatForm(form),
        EXISTING_SCHEMA: JSON.stringify(existingSchema, null, 2),
      },
    );
  } else {
    // When generating from scratch, use the full schema generation prompt
    systemPrompt = SCHEMA_FROM_GOAL_PROMPT;
    userContent = llmPrompt("schema-from-goal-user", formatForm(form));
  }

  // Send the request to the LLM using the specified model or default
  const response = await new LLMClient().sendRequest({
    model: model,
    system: systemPrompt.text,
    stream: false,
    messages: [
      {
        role: "user",
        content: userContent.text,
      },
    ],
    cache: form.meta.cache,
    metadata: {
      context: "workflow",
      workflow: "spec-and-schema-gen",
      generationId: form.meta.generationId,
      systemPrompt: systemPrompt.version,
      userPrompt: userContent.version,
      space: form.meta.charmManager.getSpaceName(),
    },
  });

  // Extract sections from the response
  const title =
    parseTagFromResponse(extractTextFromLLMResponse(response), "title") ||
    "New Charm";
  const description = parseTagFromResponse(
    extractTextFromLLMResponse(response),
    "description",
  );
  const spec = parseTagFromResponse(
    extractTextFromLLMResponse(response),
    "spec",
  );
  const plan = parseTagFromResponse(
    extractTextFromLLMResponse(response),
    "plan",
  );

  // If we have an existing schema, use it; otherwise parse the generated schema
  let resultSchema: JSONSchemaMutable;
  let argumentSchema: JSONSchemaMutable;

  try {
    const resultSchemaJson = parseTagFromResponse(
      extractTextFromLLMResponse(response),
      "result_schema",
    );
    resultSchema = resultSchemaJson ? JSON.parse(resultSchemaJson) : {};
  } catch (error) {
    console.warn("Error parsing schema:", error);
    // Fallback to an empty schema
    resultSchema = {};
  }

  try {
    const argumentSchemaJson = parseTagFromResponse(
      extractTextFromLLMResponse(response),
      "argument_schema",
    );
    argumentSchema = argumentSchemaJson ? JSON.parse(argumentSchemaJson) : {};
  } catch (error) {
    console.warn("Error parsing schema:", error);
    // Fallback to an empty schema
    argumentSchema = {};
  }

  if (!argumentSchema && resultSchema) {
    // HACK(bf): for iframes, this is ok, it will not last forever
    argumentSchema = resultSchema;
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

/**
 * Generates a complete specification, schema, and plan from a goal.
 * @param goal The user's goal or request
 * @param existingSchema Optional existing schema to use as a basis
 * @param model Optional model identifier to use (defaults to claude-3-7-sonnet)
 * @returns Object containing title, description, specification, schema
 */
export async function generateSpecAndSchemaAndCode(
  form: WorkflowForm,
  existingSchema?: JSONSchema,
  model: string = DEFAULT_MODEL_NAME,
): Promise<{
  spec: string;
  plan: string;
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
    systemPrompt = SPEC_FROM_SCHEMA_PROMPT;
    userContent = hydratePrompt(
      llmPrompt(
        "spec-and-code-from-schema-user",
        `
<user_input>
{{FORM}}
</user_input>

<existing_schema>
\`\`\`json
{{EXISTING_SCHEMA}}
\`\`\`
</existing_schema>

Based on this goal and the existing schema, please provide a title, description, any additional schema, detailed specification, and implementation plan.
`,
      ),
      {
        FORM: formatForm(form),
        EXISTING_SCHEMA: JSON.stringify(existingSchema, null, 2),
      },
    );
  } else {
    // When generating from scratch, use the full schema generation prompt
    systemPrompt = SCHEMA_FROM_GOAL_PROMPT;
    userContent = llmPrompt("schema-from-goal-user", formatForm(form));
  }

  // Send the request to the LLM using the specified model or default
  const response = await new LLMClient().sendRequest({
    model: model,
    system: systemPrompt.text,
    stream: false,
    messages: [
      {
        role: "user",
        content: userContent.text,
      },
    ],
    metadata: {
      context: "workflow",
      workflow: "spec-and-schema-gen",
      generationId: form.meta.generationId,
      systemPrompt: systemPrompt.version,
      userPrompt: userContent.version,
      space: form.meta.charmManager.getSpaceName(),
    },
    cache: form.meta.cache,
  });

  // Extract sections from the response
  const title =
    parseTagFromResponse(extractTextFromLLMResponse(response), "title") ||
    "New Charm";
  const description = parseTagFromResponse(
    extractTextFromLLMResponse(response),
    "description",
  );
  const spec = parseTagFromResponse(
    extractTextFromLLMResponse(response),
    "spec",
  );
  const plan = parseTagFromResponse(
    extractTextFromLLMResponse(response),
    "plan",
  );

  // If we have an existing schema, use it; otherwise parse the generated schema
  let resultSchema: JSONSchemaMutable;
  let argumentSchema: JSONSchemaMutable;

  try {
    const resultSchemaJson = parseTagFromResponse(
      extractTextFromLLMResponse(response),
      "result_schema",
    );
    resultSchema = resultSchemaJson ? JSON.parse(resultSchemaJson) : {};
  } catch (error) {
    console.warn("Error parsing schema:", error);
    // Fallback to an empty schema
    resultSchema = {};
  }

  try {
    const argumentSchemaJson = parseTagFromResponse(
      extractTextFromLLMResponse(response),
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
