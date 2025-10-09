import {
  DEFAULT_MODEL_NAME,
  LLMClient,
  LLMRequest,
  LLMToolCall,
} from "@commontools/llm";
import type {
  BuiltInLLMMessage,
  BuiltInLLMParams,
  BuiltInLLMTextPart,
  BuiltInLLMToolCallPart,
  JSONSchema,
  Schema,
} from "commontools";
import { getLogger } from "@commontools/utils/logger";
import { isBoolean, isObject } from "@commontools/utils/types";
import type { Cell, MemorySpace, Stream } from "../cell.ts";
import { isCell, isStream } from "../cell.ts";
import { ID, NAME, type Recipe, TYPE, UI } from "../builder/types.ts";
import type { Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { parseLink } from "../link-utils.ts";
import { isStreamValue } from "@commontools/runner";

const logger = getLogger("llm-dialog", {
  enabled: true,
  level: "info",
});

const client = new LLMClient();
const REQUEST_TIMEOUT = 1000 * 60 * 5; // 5 minutes

/**
 * Slugifies a string to match the pattern ^[a-zA-Z0-9_-]{1,128}$
 * Replaces spaces and invalid characters with underscores, truncates to 128 chars
 */
function slugify(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 128);
}

/**
 * Remove the injected `result` field from a JSON schema so tools don't
 * advertise it as an input parameter.
 */
function stripInjectedResult(
  schema: unknown,
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") return schema;

  const copy: Record<string, unknown> = { ...obj };
  const props = copy.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    const { result, ...rest } = props as Record<string, unknown>;
    copy.properties = rest;
  }
  const req = copy.required as unknown[] | undefined;
  if (Array.isArray(req)) {
    copy.required = req.filter((k) => k !== "result");
  }
  return copy;
}

// --------------------
// Helper types + utils
// --------------------

type ToolKind = "handler" | "cell" | "pattern";

type ToolDescriptor = {
  kind: ToolKind;
  name: string;
  path: string[];
  charmName: string;
  charm?: Cell<any>;
  handlerCell?: Cell<any>;
  cellRef?: Cell<any>;
  description?: string;
  schema?: JSONSchema;
};

function isCharmPrivateKey(key: string): boolean {
  return key.startsWith("$") || key === String(NAME) || key === String(UI) ||
    key === String(ID);
}

function buildToolName(charmName: string, key: string): string {
  return `${slugify(charmName)}_${slugify(key)}`;
}

function normalizeInputSchema(schemaLike: unknown): JSONSchema {
  let inputSchema: any = schemaLike;
  if (isBoolean(inputSchema)) {
    inputSchema = {
      type: "object",
      properties: {},
      additionalProperties: inputSchema,
    };
  }
  if (!isObject(inputSchema)) inputSchema = { type: "object" };
  return stripInjectedResult(inputSchema) as JSONSchema;
}

function describeTool(
  baseDescription: string | undefined,
  inputSchema: JSONSchema | undefined,
  fallback: string,
  warnIfNoSchema = false,
): string {
  let description: string | undefined = baseDescription ||
    (isBoolean(inputSchema)
      ? undefined
      : (inputSchema?.description as string | undefined));
  description = description || fallback;
  if (warnIfNoSchema && !inputSchema) description = `⚠️ ${description}`;
  return description;
}

/**
 * Discover charm-derived tools (streams as handlers, cells as readables).
 * Keeps current behavior: only top-level keys, skip private keys.
 */
function discoverTools(toolsCell: Cell<any>): Map<string, ToolDescriptor> {
  const descriptors = new Map<string, ToolDescriptor>();
  const tools = toolsCell.get() ?? {};

  for (const [name, tool] of Object.entries(tools)) {
    if (tool?.charm?.get?.()) {
      const charmCell: Cell<any> = tool.charm;
      const charm = charmCell.get();
      if (!charm || typeof charm !== "object") continue;
      const charmName = String(charm?.[NAME] || name);

      for (const [key, value] of Object.entries(charm)) {
        if (isCharmPrivateKey(key)) continue;

        if (isStreamValue(value)) {
          const handlerCell = charmCell.key(key);
          const hasSchema = !!handlerCell?.schema &&
            typeof handlerCell?.schema === "object";
          const schema = normalizeInputSchema(
            hasSchema ? handlerCell?.schema : { type: "object" },
          );
          // Prefer a specific per-key description if base exists
          const baseDesc = tool.description
            ? `${tool.description} - ${key}`
            : undefined;
          const desc = describeTool(
            baseDesc,
            hasSchema ? (handlerCell?.schema as JSONSchema) : undefined,
            `${key} handler from ${charmName}`,
            !hasSchema,
          );
          const nameBuilt = buildToolName(charmName, key);
          descriptors.set(nameBuilt, {
            kind: "handler",
            name: nameBuilt,
            path: [key],
            charmName,
            charm: charmCell,
            handlerCell,
            description: desc,
            schema,
          });
        } else if (isCell(charmCell.key(key))) {
          // Cell fields are exposed as read-only tools with no args
          const cellRef = charmCell.key(key) as Cell<any>;
          const schema = normalizeInputSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
          });
          // For cells, provide a clear read description without duplication
          const desc = `Read ${key} from ${charmName}`;
          const nameBuilt = buildToolName(charmName, key);
          descriptors.set(nameBuilt, {
            kind: "cell",
            name: nameBuilt,
            path: [key],
            charmName,
            charm: charmCell,
            cellRef,
            description: desc,
            schema,
          });
        }
      }
    }
  }

  return descriptors;
}

/**
 * Build a per-charm index for future read/run routing.
 * Groups discovered tools by charm and summarizes readable and runnable paths.
 */
// (Removed tools index; we can derive from schema on demand.)

/**
 * Best-effort sanitizer to remove injected `result` fields from any tool-like
 * object so UI consumers (e.g., ct-tools-chip) don't show it as a parameter.
 */
// Intentionally minimal sanitization for flattened tool entries. We only
// remove the injected `result` from `inputSchema` if present.

const LLMMessageSchema = {
  type: "object",
  properties: {
    role: { type: "string" },
    content: {
      anyOf: [{
        type: "array",
        items: {
          anyOf: [{
            type: "object",
            properties: {
              // This should be anyOf with const values for type
              type: { type: "string" },
              text: { type: "string" },
              image: { type: "string" },
              toolCallId: { type: "string" },
              toolName: { type: "string" },
              input: { type: "object" },
              output: {},
            },
            required: ["type"],
          }, { type: "string" }],
        },
      }, { type: "string" }],
    },
  },
  required: ["role", "content"],
} as const satisfies JSONSchema;

const LLMToolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
    handler: {
      // Deliberately no schema, so it gets populated from the handler
      asStream: true,
    },
    pattern: {
      type: "object",
      properties: {
        argumentSchema: { type: "object" },
        resultSchema: { type: "object" },
        nodes: { type: "array", items: { type: "object" } },
        program: { type: "object" },
        initial: { type: "object" },
      },
      required: ["argumentSchema", "resultSchema", "nodes"],
      asCell: true,
    },
    charm: {
      // Accept whole charm - its own schema defines its handlers
      asCell: true,
    },
  },
  required: [],
} as const satisfies JSONSchema;

const LLMParamsSchema = {
  type: "object",
  properties: {
    messages: { type: "array", items: LLMMessageSchema, default: [] },
    model: { type: "string" },
    maxTokens: { type: "number" },
    system: { type: "string" },
    tools: { type: "object", additionalProperties: LLMToolSchema, default: {} },
  },
  required: ["messages"],
} as const satisfies JSONSchema;

const resultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    addMessage: { ...LLMMessageSchema, asStream: true },
    cancelGeneration: { asStream: true },
    flattenedTools: { type: "object", default: {} },
  },
  required: ["pending", "addMessage", "cancelGeneration"],
} as const satisfies JSONSchema;

const internalSchema = {
  type: "object",
  properties: {
    requestId: { type: "string" },
    lastActivity: { type: "number" },
  },
  required: ["requestId", "lastActivity"],
} as const satisfies JSONSchema;

/**
 * Flattens tools by extracting handlers from charm-based tools.
 * Converts { charm: ... } entries into individual handler entries.
 *
 * @param toolsCell - Cell containing the tools
 * @param toolHandlers - Optional map to populate with handler references for invocation
 * @returns Flattened tools object with handler/pattern entries
 */
function flattenTools(
  toolsCell: Cell<any>,
  toolHandlers?: Map<
    string,
    { handler?: any; cell?: Cell<any>; charm: Cell<any> }
  >,
): Record<
  string,
  {
    handler?: any;
    description: string;
    inputSchema?: JSONSchema;
    internal?: { kind: ToolKind; path: string[]; charmName: string };
  }
> {
  const flattened: Record<string, any> = {};
  const tools = toolsCell.get() ?? {};

  // Discover charm-derived tools but do NOT add granular entries; we will only
  // expose aggregated <Charm>_read and <Charm>_run in the UI.
  const descriptors = discoverTools(toolsCell);

  // Preserve pass-through for non-charm tools
  for (const [name, tool] of Object.entries(tools)) {
    if (tool?.charm?.get?.()) continue; // already handled via discovery
    const passThrough: Record<string, unknown> = { ...tool };
    if (
      passThrough.inputSchema && typeof passThrough.inputSchema === "object"
    ) {
      passThrough.inputSchema = stripInjectedResult(passThrough.inputSchema);
    }
    flattened[name] = passThrough;
  }

  // Also include aggregated charm entries for visibility (<Charm>_read/<Charm>_run)
  const charms = new Map<string, { charm: Cell<any>; slug: string; readables: ToolDescriptor[]; runnables: ToolDescriptor[] }>();
  for (const desc of descriptors.values()) {
    const key = desc.charmName;
    const existing = charms.get(key) ?? { charm: desc.charm!, slug: slugify(desc.charmName), readables: [], runnables: [] };
    if (desc.kind === "cell") existing.readables.push(desc);
    if (desc.kind === "handler") existing.runnables.push(desc);
    charms.set(key, existing);
  }
  for (const [charmName, info] of charms) {
    const readName = `${info.slug}_read`;
    const runName = `${info.slug}_run`;
    const readPaths = info.readables.map((d) => d.path.join("."));
    if (readPaths.length > 0) {
      const apiShape: Record<string, unknown> = {};
      for (const d of info.readables) apiShape[d.path.join(".")] = { value: true };
      for (const d of info.runnables) apiShape[d.path.join(".")] = { Stream: d.schema ?? {} };
      const apiString = JSON.stringify(apiShape);
      flattened[readName] = {
        description: `Read values from charm "${charmName}". API: ${apiString}. Use path: string[] (single key = ["key"]).`,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["path"],
          additionalProperties: false,
        } as JSONSchema,
        internal: { kind: "cell", path: [], charmName },
      };
    }
    const runnablePaths = info.runnables.map((d) => d.path.join("."));
    if (runnablePaths.length > 0) {
      const apiShape: Record<string, unknown> = {};
      for (const d of info.readables) apiShape[d.path.join(".")] = { value: true };
      for (const d of info.runnables) apiShape[d.path.join(".")] = { Stream: d.schema ?? {} };
      const apiString = JSON.stringify(apiShape);
      flattened[runName] = {
        description: `Run handlers on charm "${charmName}". API: ${apiString}. Use path: string[] and args: object.`,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "array", items: { type: "string" }, minItems: 1 },
            args: { type: "object" },
          },
          required: ["path"],
          additionalProperties: false,
        } as JSONSchema,
        internal: { kind: "handler", path: [], charmName },
      };
    }
  }

  return flattened;
}

/**
 * Performs a mutation on the storage if the pending flag is active and the
 * request ID matches. This ensures the pending flag has final say over whether
 * the LLM continues generating.
 *
 * @param runtime - The runtime instance
 * @param pending - Cell containing the pending state
 * @param internal - Cell containing the internal state
 * @param requestId - The request ID
 * @param action - The mutation action to perform if pending is true
 * @returns true if the action was performed, false otherwise
 */
async function safelyPerformUpdate(
  runtime: IRuntime,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  action: (tx: IExtendedStorageTransaction) => void,
) {
  let success = false;
  const error = await runtime.editWithRetry((tx) => {
    if (
      pending.withTx(tx).get() &&
      internal.withTx(tx).key("requestId").get() === requestId
    ) {
      action(tx);
      internal.withTx(tx).key("lastActivity").set(Date.now());
      success = true;
    } else {
      // We might have flagged success as true in a previous call, but if the
      // retry flow lands us here, it means it wasn't written and that now
      // the requestId has changed.
      success = false;
    }
  });

  return !error && success;
}

/**
 * Ensures that a source charm is running using the charm context,
 * then calls runSynced to ensure it's actively running.
 *
 * @param runtime - The runtime instance
 * @param meta - The charm context containing handler and owning charm
 * @returns Promise that resolves when the charm is running
 */
async function ensureSourceCharmRunning(
  runtime: IRuntime,
  meta: { handler?: any; charm: Cell<any> },
): Promise<void> {
  const charm = meta.charm;
  const result = charm.asSchema({});
  const process = charm.getSourceCell();
  const recipeId = process?.get()?.[TYPE];
  if (recipeId) {
    const recipe = await runtime.recipeManager.loadRecipe(
      recipeId,
      charm.space,
    );
    await runtime.runSynced(result, recipe);
    // Ensure scheduler has registered handlers before we enqueue events
    await runtime.idle();
  }
}

/**
 * Executes a tool call by invoking its handler function and returning the
 * result. Creates a new transaction, sends the tool call arguments to the
 * handler, and waits for the result to be available before returning it.
 *
 * @param runtime - The runtime instance for creating transactions and cells
 * @param parentCell - The parent cell context for the tool execution
 * @param toolDef - Cell containing the tool definition with handler
 * @param toolCall - The LLM tool call containing id, name, and arguments
 * @param charmHandler - Optional handler for charm-extracted tools
 * @returns Promise that resolves to the tool execution result
 */
async function invokeToolCall(
  runtime: IRuntime,
  space: MemorySpace,
  toolDef: Cell<Schema<typeof LLMToolSchema>> | undefined,
  toolCall: LLMToolCall,
  charmMeta?: { handler?: any; cell?: Cell<any>; charm: Cell<any> },
) {
  const pattern = toolDef?.key("pattern").getRaw() as unknown as
    | Readonly<Recipe>
    | undefined;
  const handler = charmMeta?.handler ?? toolDef?.key("handler");
  // FIXME(bf): in practice, toolCall has toolCall.toolCallId not .id
  const result = runtime.getCell<any>(space, toolCall.id);

  // Cell tools: read via getAsQueryResult to materialize links/aliases.
  if (charmMeta?.cell) {
    const realized = charmMeta.cell.getAsQueryResult();
    // Ensure we return plain JSON by stringifying and parsing
    const value = JSON.parse(JSON.stringify(realized));
    return { type: "json", value };
  }

  // ensure the charm this handler originates from is actually running
  if (handler && !pattern && charmMeta) {
    await ensureSourceCharmRunning(runtime, charmMeta);
  }

  const { resolve, promise } = Promise.withResolvers<any>();

  runtime.editWithRetry((tx) => {
    if (pattern) {
      runtime.run(tx, pattern, toolCall.input, result);
    } else if (handler) {
      handler.withTx(tx).send({
        ...toolCall.input,
        result, // doesn't HAVE to be used, but can be
      }, (completedTx: IExtendedStorageTransaction) => {
        resolve(result.withTx(completedTx).get()); // withTx likely superfluous
      }); // TODO(bf): why any needed?
    } else {
      throw new Error("Tool has neither pattern nor handler");
    }
  });

  // wait until we know we have the result of the tool call
  // not just that the transaction has been comitted
  const cancel = result.sink((r) => {
    r !== undefined && resolve(r);
  });
  const resultValue = await promise;
  cancel();

  if (pattern) {
    // stop it now that we have the result
    runtime.runner.stop(result);
  } else {
    await runtime.idle(); // maybe pointless
  }

  return { type: "json", value: resultValue ?? "OK" }; // if there was no return value, just tell the LLM it worked
}

/**
 * Run a (tool using) dialog with an LLM.
 *
 * @param messages - list of messages representing the conversation. This is mutated by the internal process.
 * @param model - A doc to store the model to use.
 * @param system - A doc to store the system message.
 * @param stop - A doc to store (optional) stop sequence.
 * @param maxTokens - A doc to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, addMessage: (message: BuiltInLLMMessage) => void } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llmDialog(
  inputsCell: Cell<BuiltInLLMParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  const inputs = inputsCell.asSchema(LLMParamsSchema);

  // Helper function to create and register handlers
  const createHandler = <T>(
    stream: Stream<T>,
    handler: (tx: IExtendedStorageTransaction, event: T) => void,
  ) => {
    addCancel(
      runtime.scheduler.addEventHandler(handler, parseLink(stream)),
    );
  };

  let cellsInitialized = false;
  let result: Cell<Schema<typeof resultSchema>>;
  let internal: Cell<Schema<typeof internalSchema>>;
  let requestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;

  // This is called when the recipe containing this node is being stopped.
  addCancel(() => {
    // Abort the request if it's still pending.
    abortController?.abort("Recipe stopped");

    const tx = runtime.edit();

    // If the pending request is ours, set pending to false and clear the requestId.
    if (internal.withTx(tx).key("requestId").get() === requestId) {
      result.withTx(tx).key("pending").set(false);
      internal.withTx(tx).key("requestId").set("");
    }

    // Since we're aborting, don't retry. If the above fails, it's because the
    // requestId was already changing under us.
    tx.commit();
  });

  return (tx: IExtendedStorageTransaction) => {
    // Setup cells on first run.
    if (!cellsInitialized) {
      // Create result cell. The predictable cause means that it'll map to
      // previously existing results. Note that we might not yet have it loaded
      // and that this function will be called again once the data is loaded
      // (but this if branch will be skipped then).
      result = runtime.getCell(
        parentCell.space,
        { llmDialog: { result: cause } },
        resultSchema,
        tx,
      );
      result.sync(); // Kick off sync, no need to await

      // Create another cell to store the internal state. This isn't returned to
      // the caller. But again, the predictable cause means all instances tied
      // to the same input cells will coordinate via the same cell.
      internal = runtime.getCell(
        parentCell.space,
        { llmDialog: { internal: cause } },
        internalSchema,
        tx,
      );
      internal.sync(); // Kick off sync, no need to await

      const pending = result.key("pending");

      // Write the stream markers into the result cell. This write might fail
      // (since the original data wasn't loaded yet), but that's ok, since in
      // that case another instance already wrote these.
      //
      // We are carrying the existing pending state over, in case the result
      // cell was already loaded. We don't want to overwrite it.
      result.setRaw({
        ...result.getRaw(),
        addMessage: { $stream: true },
        cancelGeneration: { $stream: true },
      });

      // Declare `addMessage` handler and register
      createHandler<BuiltInLLMMessage>(
        // Cast is necessary as .key doesn't yet correctly handle Stream<>
        result.key("addMessage") as unknown as Stream<BuiltInLLMMessage>,
        (tx: IExtendedStorageTransaction, event: BuiltInLLMMessage) => {
          if (
            pending.withTx(tx).get() && (
              internal.withTx(tx).key("lastActivity").get() >
                Date.now() - REQUEST_TIMEOUT
            )
          ) {
            // For now, let's drop messages added while request is pending for
            // less than five minutes. Add message UI should either be disabled
            // or change the send button to be a stop button.
            return;
          }

          // Before starting request, set pending and append the new message.
          pending.withTx(tx).set(true);
          inputs.key("messages").withTx(tx).push(
            {
              ...event,
              // Add ID manually, as for built-ins this isn't automated
              // TODO(seefeld): Once we have event ids, it should be that.
              [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
              // Cast because we can't yet express ArrayBuffer in JSON Schema
            } as Schema<
              typeof LLMMessageSchema
            >,
          );

          // Set up new request (abort existing ones just in case) by allocating
          // a new request Id and setting up a new abort controller.
          abortController?.abort("New request started");
          abortController = new AbortController();
          requestId = crypto.randomUUID();
          internal.withTx(tx).set({
            requestId,
            lastActivity: Date.now(),
          });

          // Start a new request. This will start an async operation that will
          // outlive this handler call.
          startRequest(
            tx,
            runtime,
            parentCell.space,
            cause,
            inputs,
            pending,
            internal,
            requestId,
            abortController.signal,
          );
        },
      );

      // Declare `cancelGeneration` handler and register
      createHandler<void>(
        result.key("cancelGeneration") as unknown as Stream<any>,
        (tx: IExtendedStorageTransaction, _event: void) => {
          // Cancel request by setting pending to false. This will trigger the
          // code below to be executed in all tabs.
          pending.withTx(tx).set(false);
        },
      );

      sendResult(tx, result);
      cellsInitialized = true;
    }

    // This will remain the reactive part. It will be called whenever one of the
    // read cells change. This is why it's important to do the read before the
    // "&& requestId" part: Otherwise, we'd run this once without requestId and
    // so read no cells and then this wouldn't be called again.
    //
    // Note: If this were sandboxed code, this part would naturally read this
    // cell as it's the only way to get to requestId, here we are passing it
    // around on the side.

    // Update flattened tools whenever tools change
    const toolsCell = inputs.key("tools");
    const flattened = flattenTools(toolsCell);
    result.withTx(tx).key("flattenedTools").set(flattened as any);

    if (
      (!result.withTx(tx).key("pending").get() ||
        requestId !== internal.withTx(tx).key("requestId").get()) && requestId
    ) {
      // We have a pending request and either something set pending to false or
      // another request started, so we have to abort this one.
      abortController?.abort("Another request started");
      requestId = undefined;
    }
  };
}

function startRequest(
  tx: IExtendedStorageTransaction,
  runtime: IRuntime,
  space: MemorySpace,
  cause: any,
  inputs: Cell<Schema<typeof LLMParamsSchema>>,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  abortSignal: AbortSignal,
) {
  const { system, maxTokens, model } = inputs.get();

  const messagesCell = inputs.key("messages");
  const toolsCell = inputs.key("tools");

  // Map to store references for charm-extracted tools (handlers or cells)
  const toolHandlers = new Map<
    string,
    { handler?: any; cell?: Cell<any>; charm: Cell<any> }
  >();

  // Flatten tools (extracts handlers from charms, stores handler refs)
  const flattenedTools = flattenTools(toolsCell, toolHandlers);

  // Build LLM tools with aggregated API (two tools per charm) + pass-through non-charm
  const toolsWithSchemas: Record<string, { description: string; inputSchema: JSONSchema }>= {};

  // Pass-through non-charm tools
  for (const [name, tool] of Object.entries(toolsCell.get() ?? {})) {
    if (tool?.charm?.get?.()) continue;
    const t: any = tool as any;
    const pattern = t?.pattern?.get?.() ?? t?.pattern;
    const handler = t?.handler;
    let inputSchema = pattern?.argumentSchema ?? handler?.schema ?? t?.inputSchema;
    if (inputSchema === undefined) continue;
    inputSchema = normalizeInputSchema(inputSchema);
    let description: string = tool.description ?? (inputSchema as any)?.description ?? "";
    toolsWithSchemas[name] = { description, inputSchema };
  }

  // Aggregated charm tools
  const descriptors = discoverTools(toolsCell);
  const charms = new Map<string, { charm: Cell<any>; slug: string; readables: ToolDescriptor[]; runnables: ToolDescriptor[] }>();
  for (const desc of descriptors.values()) {
    const key = desc.charmName;
    const existing = charms.get(key) ?? { charm: desc.charm!, slug: slugify(desc.charmName), readables: [], runnables: [] };
    if (desc.kind === "cell") existing.readables.push(desc);
    if (desc.kind === "handler") existing.runnables.push(desc);
    charms.set(key, existing);
  }

  const aggregatedTools = new Map<string, { charm: Cell<any>; readablesByDot: Map<string, Cell<any>>; runnablesByDot: Map<string, { handler: Cell<any> }> }>();

  for (const [charmName, info] of charms) {
    const readName = `${info.slug}_read`;
    const runName = `${info.slug}_run`;

    const readPaths = info.readables.map((d) => d.path.join("."));
    if (readPaths.length > 0) {
      const apiShape: Record<string, unknown> = {};
      for (const d of info.readables) apiShape[d.path.join(".")] = { value: true };
      for (const d of info.runnables) apiShape[d.path.join(".")] = { Stream: d.schema ?? {} };
      const apiString = JSON.stringify(apiShape);
      toolsWithSchemas[readName] = {
        description: `Read values from charm "${charmName}". API: ${apiString}. Use path: string[] (single key = ["key"]).`,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["path"],
          additionalProperties: false,
        } as JSONSchema,
      };
    }

    const runnablePaths = info.runnables.map((d) => d.path.join("."));
    if (runnablePaths.length > 0) {
      const apiShape: Record<string, unknown> = {};
      for (const d of info.readables) apiShape[d.path.join(".")] = { value: true };
      for (const d of info.runnables) apiShape[d.path.join(".")] = { Stream: d.schema ?? {} };
      const apiString = JSON.stringify(apiShape);
      toolsWithSchemas[runName] = {
        description: `Run handlers on charm "${charmName}". API: ${apiString}. Use path: string[] and args: object.`,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "array", items: { type: "string" }, minItems: 1 },
            args: { type: "object" },
          },
          required: ["path"],
          additionalProperties: false,
        } as JSONSchema,
      };
    }

    // Prepare aggregates for invocation
    const readablesByDot = new Map<string, Cell<any>>();
    for (const d of info.readables) readablesByDot.set(d.path.join("."), d.cellRef!);
    const runnablesByDot = new Map<string, { handler: Cell<any> }>();
    for (const d of info.runnables) runnablesByDot.set(d.path.join("."), { handler: d.handlerCell! });
    aggregatedTools.set(readName, { charm: info.charm, readablesByDot, runnablesByDot });
    aggregatedTools.set(runName, { charm: info.charm, readablesByDot, runnablesByDot });
  }

  const llmParams: LLMRequest = {
    system: system ?? "",
    messages: messagesCell.withTx(tx).get() as BuiltInLLMMessage[],
    maxTokens: maxTokens,
    stream: true,
    model: model ?? DEFAULT_MODEL_NAME,
    metadata: {
      // FIXME(ja): how do we get the context of space/charm id here
      // bf: I also do not know... this one is tricky
      context: "charm",
    },
    cache: true,
    tools: toolsWithSchemas, // Pass through tools if provided
  };

  // TODO(bf): sendRequest must be given a callback, even if it does nothing
  const resultPromise = client.sendRequest(llmParams, () => {}, abortSignal);

  resultPromise
    .then(async (llmResult) => {
      // Extract tool calls from content if it's an array
      const hasToolCalls = Array.isArray(llmResult.content) &&
        llmResult.content.some((part) => part.type === "tool-call");

      if (hasToolCalls) {
        try {
          const newMessages: BuiltInLLMMessage[] = [];

          // Create assistant message with tool-call content parts
          const assistantContentParts: Array<
            BuiltInLLMTextPart | BuiltInLLMToolCallPart
          > = [];

          // Add text content if present
          if (typeof llmResult.content === "string" && llmResult.content) {
            assistantContentParts.push({
              type: "text",
              text: llmResult.content,
            });
          } else if (Array.isArray(llmResult.content)) {
            // Content is already an array of parts, use it directly
            assistantContentParts.push(
              ...llmResult.content.filter((part) => part.type === "text"),
            );
          }

          // Extract tool calls from content parts
          const toolCallParts = (llmResult.content as any[]).filter((part) =>
            part.type === "tool-call"
          ) as BuiltInLLMToolCallPart[];

          for (const toolCallPart of toolCallParts) {
            assistantContentParts.push(toolCallPart);
          }

          const assistantMessage: BuiltInLLMMessage = {
            role: "assistant",
            content: assistantContentParts,
          };

          // Execute each tool call and collect results
          const toolResults: any[] = [];
          // Snapshot tools object to detect presence of legacy/non-aggregated tool defs
          const toolsObj = toolsCell.get() ?? {};
          for (const toolCallPart of toolCallParts) {
            try {
              const name = toolCallPart.toolName;
              let charmMeta = toolHandlers.get(name);
              let toolDef: Cell<Schema<typeof LLMToolSchema>> | undefined = undefined;
              if (!charmMeta && Object.prototype.hasOwnProperty.call(toolsObj, name)) {
                toolDef = toolsCell.key(name) as unknown as Cell<Schema<typeof LLMToolSchema>>;
              }

              // New aggregated API: <Charm>_read | <Charm>_run
              let adjustedInput = toolCallPart.input;
              if (!charmMeta && !toolDef && aggregatedTools.has(name)) {
                const agg = aggregatedTools.get(name)!;
                const input = toolCallPart.input as any;
                if (name.endsWith("_read")) {
                  const parts = Array.isArray((input as any)?.path)
                    ? (input as any).path.map((s: any) => String(s))
                    : [];
                  if (parts.length === 0) {
                    throw new Error("path must be an array of strings");
                  }
                  const pathDot = parts.join(".");
                  let cellRef = agg.readablesByDot.get(pathDot);
                  // Fallback to dynamic resolution for nested paths
                  if (!cellRef) {
                    const segs = parts.filter(Boolean);
                    let ref: Cell<any> = agg.charm;
                    for (const p of segs) ref = ref.key(p as any);
                    cellRef = ref;
                  }
                  charmMeta = { cell: cellRef!, charm: agg.charm } as any;
                } else if (name.endsWith("_run")) {
                  const parts = Array.isArray((input as any)?.path)
                    ? (input as any).path.map((s: any) => String(s))
                    : [];
                  if (parts.length === 0) {
                    throw new Error("path must be an array of strings");
                  }
                  const pathDot = parts.join(".");
                  let handlerRef = agg.runnablesByDot.get(pathDot)?.handler;
                  if (!handlerRef) {
                    const segs = parts.filter(Boolean);
                    let ref: Cell<any> = agg.charm;
                    for (const p of segs) ref = ref.key(p as any);
                    handlerRef = ref as any;
                  }
                  charmMeta = { handler: handlerRef!, charm: agg.charm } as any;
                  // For run tools, pass only handler args. Accept both shapes:
                  // either nested under `args`, or top-level fields alongside path.
                  toolDef = undefined;
                  const nestedArgs = (input && typeof input === "object") ? input.args : undefined;
                  if (nestedArgs !== undefined) {
                    adjustedInput = nestedArgs;
                  } else {
                    const { path, ...rest } = (input && typeof input === "object") ? input : {} as any;
                    adjustedInput = rest;
                  }
                }
              }

              const resultValue = await invokeToolCall(
                runtime,
                space,
                toolDef,
                {
                  id: toolCallPart.toolCallId,
                  name: toolCallPart.toolName,
                  input: adjustedInput,
                },
                charmMeta,
              );
              toolResults.push({ id: toolCallPart.toolCallId, result: resultValue });
            } catch (error) {
              console.error(`Tool ${toolCallPart.toolName} failed:`, error);
              toolResults.push({
                id: toolCallPart.toolCallId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          // Add assistant message with tool calls
          newMessages.push(assistantMessage);

          // Add tool result messages
          for (const toolResult of toolResults) {
            const matchingToolCallPart = toolCallParts.find((tc) =>
              tc.toolCallId === toolResult.id
            );
            newMessages.push({
              role: "tool",
              content: [{
                type: "tool-result",
                toolCallId: toolResult.id,
                toolName: matchingToolCallPart?.toolName || "unknown",
                output: toolResult.error
                  ? { type: "error-text", value: toolResult.error }
                  : toolResult.result,
              }],
            });
          }

          newMessages.forEach((message) => {
            (message as BuiltInLLMMessage & { [ID]: unknown })[ID] = {
              llmDialog: { message: cause, id: crypto.randomUUID() },
            };
          });

          const success = await safelyPerformUpdate(
            runtime,
            pending,
            internal,
            requestId,
            (tx) => {
              messagesCell.withTx(tx).push(
                ...(newMessages as Schema<typeof LLMMessageSchema>[]),
              );
            },
          );

          if (success) {
            console.log("Continuing conversation after tool calls...");

            const continueTx = runtime.edit();
            startRequest(
              continueTx,
              runtime,
              space,
              cause,
              inputs,
              pending,
              internal,
              requestId,
              abortSignal,
            );
            continueTx.commit();
          } else {
            console.info("Did not write to conversation due to pending=false");
          }
        } catch (error: unknown) {
          console.error(error);
        }
      } else {
        // No tool calls, just add the assistant message
        const assistantMessage = {
          [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
          role: "assistant",
          content: llmResult.content,
        } satisfies BuiltInLLMMessage & { [ID]: unknown };

        // Ignore errors here, it probably means something else took over.
        await safelyPerformUpdate(
          runtime,
          pending,
          internal,
          requestId,
          (tx) => {
            messagesCell.withTx(tx).push(
              assistantMessage as Schema<typeof LLMMessageSchema>,
            );
            pending.withTx(tx).set(false);
          },
        );
      }
    })
    .catch((error: unknown) => {
      console.error("Error generating data", error);
      runtime.editWithRetry((tx) => {
        pending.withTx(tx).set(false);
      });
    });
}
