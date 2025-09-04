import { isObject, Mutable } from "@commontools/utils/types";
import {
  type Cell,
  createJsonSchema,
  isCell,
  isStream,
  type JSONSchema,
  type JSONSchemaMutable,
  type MemorySpace,
  type RecipeMeta,
  type Runtime,
  type RuntimeProgram,
} from "@commontools/runner";
import { Charm, CharmManager, charmSourceCellSchema } from "./manager.ts";
import { buildFullRecipe, getIframeRecipe } from "./iframe/recipe.ts";
import { buildPrompt, RESPONSE_PREFILL } from "./iframe/prompt.ts";
import {
  applyDefaults,
  formatForm,
  generateCodeAndSchema,
  generateSpecAndSchema,
  type GenerationOptions,
  LLMClient,
} from "@commontools/llm";
import { injectUserCode } from "./iframe/static.ts";
import { IFrameRecipe, WorkflowForm } from "./index.ts";
import { console } from "./conditional-console.ts";
import { StaticCache } from "@commontools/static";

const llm = new LLMClient();

/**
 * Generate source code for a charm based on its specification, schema, and optional existing source
 */
export const genSrc = async (
  {
    src,
    spec,
    newSpec,
    schema,
    steps,
    staticCache,
  }: {
    src?: string;
    spec?: string;
    newSpec: string;
    schema: JSONSchema;
    steps?: string[];
    staticCache: StaticCache;
  },
  options?: GenerationOptions,
): Promise<{ content: string; llmRequestId?: string }> => {
  const optionsWithDefaults = applyDefaults(options);
  const { model, cache, space, generationId } = optionsWithDefaults;

  const request = await buildPrompt({
    src,
    spec,
    newSpec,
    schema,
    steps,
    staticCache,
  }, optionsWithDefaults);

  globalThis.dispatchEvent(
    new CustomEvent("job-update", {
      detail: {
        type: "job-update",
        jobId: generationId,
        status: `Generating source code ${model}...`,
      },
    }),
  );

  const response = await llm.sendRequest({
    ...request,
    metadata: {
      ...request.metadata,
      context: "workflow",
      workflow: "genSrc",
      generationId,
      space,
    },
    cache,
  });

  // FIXME(ja): this is a hack to get the prefill to work
  if (!response.content.startsWith(RESPONSE_PREFILL)) {
    response.content = RESPONSE_PREFILL + response.content;
  }

  const source = injectUserCode(
    response.content.split(RESPONSE_PREFILL)[1].split("\n```")[0],
  );
  return { content: source, llmRequestId: response.id };
};

/**
 * Iterate on an existing charm by generating new source code based on a new specification
 * This is a core function used by various workflows
 */
export async function iterate(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  plan: WorkflowForm["plan"],
  options?: GenerationOptions,
): Promise<{ cell: Cell<Charm>; llmRequestId?: string }> {
  const optionsWithDefaults = applyDefaults(options);
  const { model, cache, space, generationId } = optionsWithDefaults;
  const { iframe } = getIframeRecipe(charm, charmManager.runtime);

  const prevSpec = iframe?.spec;
  if (plan?.description === undefined) {
    throw new Error("No specification provided");
  }
  const newSpec = plan.description;

  const { content: newIFrameSrc, llmRequestId } = await genSrc({
    src: iframe?.src,
    spec: prevSpec,
    newSpec,
    schema: iframe?.argumentSchema || { type: "object" },
    steps: plan?.features,
    staticCache: charmManager.runtime.staticCache,
  }, optionsWithDefaults);

  return {
    cell: await generateNewRecipeVersion(
      charmManager,
      charm,
      {
        src: newIFrameSrc,
        spec: newSpec,
      },
      generationId,
      llmRequestId,
    ),
    llmRequestId,
  };
}

export function extractTitle(src: string, defaultTitle: string): string {
  const htmlTitleMatch = src.match(/<title>(.*?)<\/title>/)?.[1];
  const jsTitleMatch = src.match(/const title = ['"](.*)['"];?/)?.[1];
  return htmlTitleMatch || jsTitleMatch || defaultTitle;
}

export const generateNewRecipeVersion = async (
  charmManager: CharmManager,
  parent: Cell<Charm>,
  newRecipe:
    & Pick<IFrameRecipe, "src" | "spec">
    & Partial<Omit<IFrameRecipe, "src" | "spec">>,
  generationId?: string,
  llmRequestId?: string,
) => {
  const parentInfo = getIframeRecipe(parent, charmManager.runtime);
  if (!parentInfo.recipeId) {
    throw new Error("No recipeId found for charm");
  }

  const parentRecipe = await charmManager.runtime.recipeManager.loadRecipe(
    parentInfo.recipeId,
    charmManager.getSpace(),
  );

  const name = extractTitle(newRecipe.src, "<unknown>");
  const argumentSchema =
    (parentInfo.iframe
      ? parentInfo.iframe.argumentSchema
      : parentRecipe.argumentSchema) ?? { type: "object" };
  const resultSchema =
    (parentInfo.iframe
      ? parentInfo.iframe.resultSchema
      : parentRecipe.resultSchema) ?? { type: "object" };

  const fullSrc = buildFullRecipe({
    ...parentInfo.iframe, // ignored if undefined
    argumentSchema,
    resultSchema,
    ...newRecipe,
    name,
  });

  globalThis.dispatchEvent(
    new CustomEvent("job-update", {
      detail: {
        type: "job-update",
        jobId: generationId,
        status: "Compiling recipe...",
      },
    }),
  );

  // Pass the newSpec so it's properly persisted and can be displayed/edited
  const newCharm = await compileAndRunRecipe(
    charmManager,
    fullSrc,
    newRecipe.spec!,
    parent.getSourceCell()?.key("argument"),
    parentInfo.recipeId ? [parentInfo.recipeId] : undefined,
    llmRequestId,
  );

  const tx = newCharm.runtime.edit();
  newCharm.withTx(tx).getSourceCell(charmSourceCellSchema)?.key("lineage").push(
    {
      charm: parent,
      relation: "iterate",
      timestamp: Date.now(),
    },
  );
  await tx.commit(); // TODO(seefeld): We don't retry writing this. Should we?

  return newCharm;
};

// FIXME(ja): this should handle multiple depths and/or
// a single depth - eg if you send { calendar: result1, email: result2 }
// it should scrub the result1 and result2 and
// return { calendar: scrub(result1), email: scrub(result2) }
// FIXME(seefeld): might be able to use asSchema here...
export function scrub(data: unknown): unknown {
  if (isCell(data)) {
    if (data.schema?.type === "object" && data.schema.properties) {
      // If there are properties, remove $UI and $NAME and any streams
      const scrubbed = Object.fromEntries(
        Object.entries(data.schema.properties).filter(([key, value]) =>
          !key.startsWith("$") && (!isObject(value) || !value.asStream)
        ),
      );
      console.log("scrubbed modified schema", scrubbed, data.schema);
      // If this resulted in an empty schema, return without a schema
      return data.asSchema(
        Object.keys(scrubbed).length > 0
          ? {
            ...data.schema,
            properties: scrubbed,
            additionalProperties: false,
          }
          : undefined,
      );
    } else {
      const value = data.asSchema().get();
      if (isObject(value)) {
        // Generate a new schema for all properties except $UI and $NAME and streams
        const scrubbed = {
          type: "object",
          properties: Object.fromEntries(
            Object.keys(value).filter(([key, value]) =>
              !key.startsWith("$") && !isStream(value)
            ).map(
              (key) => [key, {}],
            ),
          ),
          additionalProperties: false,
        } as const satisfies JSONSchema;
        console.log("scrubbed generated schema", scrubbed);
        // Only if we found any properties, return the scrubbed schema
        return Object.keys(scrubbed).length > 0
          ? data.asSchema(scrubbed)
          : data;
      } else return data;
    }
  } else if (Array.isArray(data)) {
    return data.map((value) => scrub(value));
  } else if (isObject(data)) {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, scrub(value)]),
    );
  } else return data;
}

/**
 * Turn cells references into writes redirects, this forces writes to go back to
 * the original cell.
 * @param data The data to process
 * @param baseSpace Optional base space DID to make links relative to
 */
function turnCellsIntoWriteRedirects(
  data: unknown,
  baseSpace?: MemorySpace,
): unknown {
  if (isCell(data)) {
    return data.getAsWriteRedirectLink(baseSpace ? { baseSpace } : undefined);
  } else if (Array.isArray(data)) {
    return data.map((value) => turnCellsIntoWriteRedirects(value, baseSpace));
  } else if (isObject(data)) {
    return Object.fromEntries(
      Object.entries(data).map((
        [key, value],
      ) => [key, turnCellsIntoWriteRedirects(value, baseSpace)]),
    );
  } else return data;
}

async function singlePhaseCodeGeneration(
  form: WorkflowForm,
  existingSchema?: JSONSchema,
) {
  console.log("using singlePhaseCodeGeneration");
  globalThis.dispatchEvent(
    new CustomEvent("job-update", {
      detail: {
        type: "job-update",
        jobId: form.meta.generationId,
        status: `Generating code and schema ${form.meta.model}...`,
      },
    }),
  );
  // Phase 1: Generate spec/plan and schema based on goal and possibly existing schema
  const {
    sourceCode,
    resultSchema,
    title,
    description,
    llmRequestId,
  } = await generateCodeAndSchema(form, existingSchema, form.meta.model);

  console.log("resultSchema", resultSchema);

  // NOTE(ja): we put the result schema in the argument schema
  // as a hack to work around iframes not supporting results schemas
  const schema = {
    ...existingSchema,
    title: title || "missing",
    description,
  } as JSONSchemaMutable;

  if (!schema.type) {
    schema.type = "object";
  }

  if (schema.type === "object" && !schema.properties) {
    schema.properties = {};
  }

  // FIXME(ja): we shouldn't just throw results into the argument schema
  // as this is a hack...
  if (schema.type === "object") {
    const props = resultSchema.properties ?? {};
    Object.keys(props).forEach((key) => {
      if (schema.properties && schema.properties[key]) {
        console.error(`skipping ${key} already in the argument schema`);
      } else {
        (schema.properties as Record<string, JSONSchema>)[key] = props[key];
      }
    });
  }

  if (!form.plan?.description || !form.plan?.features) {
    throw new Error("Plan is missing spec or steps");
  }

  const fullCode = injectUserCode(sourceCode);

  const name = extractTitle(sourceCode, title); // Use the generated title as fallback
  const newRecipeSrc = buildFullRecipe({
    src: fullCode,
    spec: form.plan.description,
    plan: Array.isArray(form.plan.features)
      ? form.plan.features.map((step, index) => `${index + 1}. ${step}`).join(
        "\n",
      )
      : form.plan.features,
    goal: form.input.processedInput,
    argumentSchema: schema,
    resultSchema,
    name,
  });

  return {
    newSpec: form.plan.description,
    newIFrameSrc: fullCode,
    newRecipeSrc,
    name,
    schema,
    llmRequestId,
  };
}

async function twoPhaseCodeGeneration(
  form: WorkflowForm,
  existingSchema?: JSONSchema,
) {
  console.log("using twoPhaseCodeGeneration");
  globalThis.dispatchEvent(
    new CustomEvent("job-update", {
      detail: {
        type: "job-update",
        jobId: form.meta.generationId,
        status: `Generating spec and schema ${form.meta.model}...`,
      },
    }),
  );
  // Phase 1: Generate spec/plan and schema based on goal and possibly existing schema
  const {
    spec,
    resultSchema,
    title,
    description,
    plan,
  } = await generateSpecAndSchema(form, existingSchema, form.meta.model);

  console.log("resultSchema", resultSchema);

  // We're going from loose plan to detailed plan here.
  const newSpec = `<REQUEST>${
    formatForm(form)
  }</REQUEST>\n<PLAN>${plan}</PLAN>\n<SPEC>${spec}</SPEC>`;

  console.log("newSpec", newSpec);

  // NOTE(ja): we put the result schema in the argument schema
  // as a hack to work around iframes not supporting results schemas
  const schema = {
    ...existingSchema,
    title: title || "missing",
    description,
  } as JSONSchemaMutable;

  if (!schema.type) {
    schema.type = "object";
  }

  if (schema.type === "object" && !schema.properties) {
    schema.properties = {};
  }

  // FIXME(ja): we shouldn't just throw results into the argument schema
  // as this is a hack...
  if (schema.type === "object") {
    const props = resultSchema.properties ?? {};
    Object.keys(props).forEach((key) => {
      if (schema.properties && schema.properties[key]) {
        console.error(`skipping ${key} already in the argument schema`);
      } else {
        (schema.properties as Record<string, JSONSchema>)[key] = props[key];
      }
    });
  }

  // Phase 2: Generate UI code using the schema and enhanced spec
  const { content: newIFrameSrc, llmRequestId } = await genSrc({
    newSpec,
    schema,
    steps: form.plan?.features,
    staticCache: form.meta.charmManager.runtime.staticCache,
  }, {
    model: form.meta.model,
    generationId: form.meta.generationId,
    cache: form.meta.cache,
    space: form.meta.charmManager.getSpaceName(),
  });

  const name = extractTitle(newIFrameSrc, title); // Use the generated title as fallback
  const newRecipeSrc = buildFullRecipe({
    src: newIFrameSrc,
    spec,
    plan,
    goal: form.input.processedInput,
    argumentSchema: schema,
    resultSchema,
    name,
  });

  return {
    newSpec,
    newIFrameSrc,
    newRecipeSrc,
    name,
    schema,
    llmRequestId,
  };
}

/**
 * Cast a new recipe from a goal and data
 *
 * @param charmManager Charm manager representing the space this will be generated in
 * @param goal A user level goal for the new recipe, can reference specific data via `key`
 * @param data Data passed to the recipe, can be a combination of data and cells
 * @returns A new recipe cell
 */
export async function castNewRecipe(
  charmManager: CharmManager,
  form: WorkflowForm,
): Promise<{ cell: Cell<Charm>; llmRequestId?: string }> {
  console.log("Processing form:", form);

  // Remove $UI, $NAME, and any streams from the cells
  const scrubbed = scrub(form.input.references);

  // First, extract any existing schema if we have data
  const existingSchema = createJsonSchema(
    scrubbed,
    false,
    charmManager.runtime,
  );

  // Prototype workflow: combine steps
  const { newSpec, newRecipeSrc, llmRequestId } =
    form.classification?.workflowType === "imagine-single-phase"
      ? await singlePhaseCodeGeneration(form, existingSchema)
      : await twoPhaseCodeGeneration(form, existingSchema);

  const input = turnCellsIntoWriteRedirects(scrubbed, charmManager.getSpace());

  globalThis.dispatchEvent(
    new CustomEvent("job-update", {
      detail: {
        type: "job-update",
        jobId: form.meta.generationId,
        status: "Compiling recipe...",
      },
    }),
  );

  return {
    cell: await compileAndRunRecipe(
      charmManager,
      newRecipeSrc,
      newSpec,
      input,
      undefined,
      llmRequestId,
    ),
    llmRequestId,
  };
}

export async function compileRecipe(
  recipeSrc: string | RuntimeProgram,
  spec: string,
  runtime: Runtime,
  space: MemorySpace,
  parents?: string[],
) {
  const recipe = await runtime.recipeManager.compileRecipe(recipeSrc);

  if (!recipe) {
    throw new Error("No default recipe found in the compiled exports.");
  }
  const parentsIds = parents?.map((id) => id.toString());
  const recipeId = runtime.recipeManager.registerRecipe(recipe, recipeSrc);

  // Record metadata fields (spec, parents) for this recipe
  runtime.recipeManager.setRecipeMetaFields(recipeId, {
    spec,
    parents: parentsIds,
  } as Partial<Mutable<RecipeMeta>>);
  await runtime.recipeManager.saveAndSyncRecipe({
    recipeId,
    space,
  });

  return recipe;
}

export async function compileAndRunRecipe(
  charmManager: CharmManager,
  recipeSrc: string,
  spec: string,
  runOptions: unknown,
  parents?: string[],
  llmRequestId?: string,
): Promise<Cell<Charm>> {
  const recipe = await compileRecipe(
    recipeSrc,
    spec,
    charmManager.runtime,
    charmManager.getSpace(),
    parents,
  );
  if (!recipe) {
    throw new Error("Failed to compile recipe");
  }

  return await charmManager.runPersistent(
    recipe,
    runOptions,
    undefined,
    llmRequestId,
  );
}
