import { isObject, Mutable } from "@commontools/utils/types";
import {
  type Cell,
  createJsonSchema,
  isCell,
  isStream,
  type JSONSchema,
  type JSONSchemaMutable,
  type MemorySpace,
  type PatternMeta,
  type Runtime,
  type RuntimeProgram,
} from "@commontools/runner";
import { PieceManager } from "./manager.ts";
import { pieceSourceCellSchema } from "@commontools/runner/schemas";
import { buildFullPattern, getIframePattern } from "./iframe/pattern.ts";
import { buildPrompt, RESPONSE_PREFILL } from "./iframe/prompt.ts";
import {
  applyDefaults,
  extractTextFromLLMResponse,
  formatForm,
  generateCodeAndSchema,
  generateSpecAndSchema,
  type GenerationOptions,
  LLMClient,
} from "@commontools/llm";
import { injectUserCode } from "./iframe/static.ts";
import { IFramePattern, WorkflowForm } from "./index.ts";
import { console } from "./conditional-console.ts";
import { StaticCache } from "@commontools/static";

const llm = new LLMClient();

/**
 * Generate source code for a piece based on its specification, schema, and optional existing source
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
  // TODO(bf): this probably doesn't work properly when the response.content is an array
  const responseText = extractTextFromLLMResponse(response);
  if (!responseText.startsWith(RESPONSE_PREFILL)) {
    response.content = RESPONSE_PREFILL + responseText;
  }

  const finalContent = extractTextFromLLMResponse(response);
  const source = injectUserCode(
    finalContent.split(RESPONSE_PREFILL)[1].split("\n```")[0],
  );
  return { content: source, llmRequestId: response.id };
};

/**
 * Iterate on an existing piece by generating new source code based on a new specification
 * This is a core function used by various workflows
 */
export async function iterate(
  pieceManager: PieceManager,
  piece: Cell<unknown>,
  plan: WorkflowForm["plan"],
  options?: GenerationOptions,
): Promise<{ cell: Cell<unknown>; llmRequestId?: string }> {
  const optionsWithDefaults = applyDefaults(options);
  const { generationId } = optionsWithDefaults;
  const { iframe } = getIframePattern(piece, pieceManager.runtime);

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
    staticCache: pieceManager.runtime.staticCache,
  }, optionsWithDefaults);

  return {
    cell: await generateNewPatternVersion(
      pieceManager,
      piece,
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

export const generateNewPatternVersion = async (
  pieceManager: PieceManager,
  parent: Cell<unknown>,
  newPattern:
    & Pick<IFramePattern, "src" | "spec">
    & Partial<Omit<IFramePattern, "src" | "spec">>,
  generationId?: string,
  llmRequestId?: string,
) => {
  const parentInfo = getIframePattern(parent, pieceManager.runtime);
  if (!parentInfo.patternId) {
    throw new Error("No patternId found for piece");
  }

  const parentPattern = await pieceManager.runtime.patternManager.loadPattern(
    parentInfo.patternId,
    pieceManager.getSpace(),
  );

  const name = extractTitle(newPattern.src, "<unknown>");
  const argumentSchema =
    (parentInfo.iframe
      ? parentInfo.iframe.argumentSchema
      : parentPattern.argumentSchema) ?? { type: "object" };
  const resultSchema =
    (parentInfo.iframe
      ? parentInfo.iframe.resultSchema
      : parentPattern.resultSchema) ?? { type: "object" };

  const fullSrc = buildFullPattern({
    ...parentInfo.iframe, // ignored if undefined
    argumentSchema,
    resultSchema,
    ...newPattern,
    name,
  });

  globalThis.dispatchEvent(
    new CustomEvent("job-update", {
      detail: {
        type: "job-update",
        jobId: generationId,
        status: "Compiling pattern...",
      },
    }),
  );

  // Pass the newSpec so it's properly persisted and can be displayed/edited
  const newPiece = await compileAndRunPattern(
    pieceManager,
    fullSrc,
    newPattern.spec!,
    parent.getSourceCell()?.key("argument"),
    parentInfo.patternId ? [parentInfo.patternId] : undefined,
    llmRequestId,
  );

  await newPiece.runtime.editWithRetry((tx) => {
    newPiece.withTx(tx).getSourceCell(pieceSourceCellSchema)?.key("lineage")
      .push(
        {
          piece: parent as Cell<{ [x: string]: unknown }>,
          relation: "iterate",
          timestamp: Date.now(),
        },
      );
  });

  return newPiece;
};

// FIXME(ja): this should handle multiple depths and/or
// a single depth - eg if you send { calendar: result1, email: result2 }
// it should scrub the result1 and result2 and
// return { calendar: scrub(result1), email: scrub(result2) }
// FIXME(seefeld): might be able to use asSchema here...
export function scrub(data: unknown): unknown {
  if (isCell(data)) {
    if (
      isObject(data.schema) && data.schema?.type === "object" &&
      data.schema.properties
    ) {
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
  const schema: JSONSchemaMutable = {
    ...(isObject(existingSchema)
      ? (structuredClone(existingSchema) as JSONSchemaMutable)
      : {}),
    title: title || "missing",
    description,
  };

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
      } else if (typeof props[key] === "boolean") {
        schema.properties![key] = props[key];
      } else {
        schema.properties![key] = structuredClone(
          props[key],
        ) as JSONSchemaMutable;
      }
    });
  }

  if (!form.plan?.description || !form.plan?.features) {
    throw new Error("Plan is missing spec or steps");
  }

  const fullCode = injectUserCode(sourceCode);

  const name = extractTitle(sourceCode, title); // Use the generated title as fallback
  const newPatternSrc = buildFullPattern({
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
    newPatternSrc,
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
  const schema: JSONSchemaMutable = {
    ...(isObject(existingSchema)
      ? (structuredClone(existingSchema) as JSONSchemaMutable)
      : {}),
    title: title || "missing",
    description,
  };

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
      } else if (typeof props[key] === "boolean") {
        schema.properties![key] = props[key];
      } else {
        schema.properties![key] = structuredClone(
          props[key],
        ) as JSONSchemaMutable;
      }
    });
  }

  // Phase 2: Generate UI code using the schema and enhanced spec
  const { content: newIFrameSrc, llmRequestId } = await genSrc({
    newSpec,
    schema,
    steps: form.plan?.features,
    staticCache: form.meta.pieceManager.runtime.staticCache,
  }, {
    model: form.meta.model,
    generationId: form.meta.generationId,
    cache: form.meta.cache,
    space: form.meta.pieceManager.getSpaceName(),
  });

  const name = extractTitle(newIFrameSrc, title); // Use the generated title as fallback
  const newPatternSrc = buildFullPattern({
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
    newPatternSrc,
    name,
    schema,
    llmRequestId,
  };
}

/**
 * Cast a new pattern from a goal and data
 *
 * @param pieceManager Piece manager representing the space this will be generated in
 * @param goal A user level goal for the new pattern, can reference specific data via `key`
 * @param data Data passed to the pattern, can be a combination of data and cells
 * @returns A new pattern cell
 */
export async function castNewPattern(
  pieceManager: PieceManager,
  form: WorkflowForm,
): Promise<{ cell: Cell<unknown>; llmRequestId?: string }> {
  console.log("Processing form:", form);

  // Remove $UI, $NAME, and any streams from the cells
  const scrubbed = scrub(form.input.references);

  // First, extract any existing schema if we have data
  const existingSchema = createJsonSchema(
    scrubbed,
    false,
    pieceManager.runtime,
  );

  // Prototype workflow: combine steps
  const { newSpec, newPatternSrc, llmRequestId } =
    form.classification?.workflowType === "imagine-single-phase"
      ? await singlePhaseCodeGeneration(form, existingSchema)
      : await twoPhaseCodeGeneration(form, existingSchema);

  const input = turnCellsIntoWriteRedirects(scrubbed, pieceManager.getSpace());

  globalThis.dispatchEvent(
    new CustomEvent("job-update", {
      detail: {
        type: "job-update",
        jobId: form.meta.generationId,
        status: "Compiling pattern...",
      },
    }),
  );

  return {
    cell: await compileAndRunPattern(
      pieceManager,
      newPatternSrc,
      newSpec,
      input,
      undefined,
      llmRequestId,
    ),
    llmRequestId,
  };
}

export async function compilePattern(
  patternSrc: string | RuntimeProgram,
  spec: string,
  runtime: Runtime,
  space: MemorySpace,
  parents?: string[],
) {
  const pattern = await runtime.patternManager.compilePattern(patternSrc);

  if (!pattern) {
    throw new Error("No default pattern found in the compiled exports.");
  }
  const parentsIds = parents?.map((id) => id.toString());
  const patternId = runtime.patternManager.registerPattern(pattern, patternSrc);

  // Record metadata fields (spec, parents) for this pattern
  await runtime.patternManager.setPatternMetaFields(patternId, {
    spec,
    parents: parentsIds,
  } as Partial<Mutable<PatternMeta>>);
  await runtime.patternManager.saveAndSyncPattern({
    patternId,
    space,
  });

  return pattern;
}

/** @deprecated Use compilePattern instead */
export const compileRecipe = compilePattern;

export async function compileAndRunPattern(
  pieceManager: PieceManager,
  patternSrc: string,
  spec: string,
  runOptions: unknown,
  parents?: string[],
  llmRequestId?: string,
): Promise<Cell<unknown>> {
  const pattern = await compilePattern(
    patternSrc,
    spec,
    pieceManager.runtime,
    pieceManager.getSpace(),
    parents,
  );
  if (!pattern) {
    throw new Error("Failed to compile pattern");
  }

  return await pieceManager.runPersistent(
    pattern,
    runOptions,
    undefined,
    llmRequestId,
  );
}

/** @deprecated Use compileAndRunPattern instead */
export const compileAndRunRecipe = compileAndRunPattern;

/** @deprecated Use generateNewPatternVersion instead */
export const generateNewRecipeVersion = generateNewPatternVersion;

/** @deprecated Use castNewPattern instead */
export const castNewRecipe = castNewPattern;
