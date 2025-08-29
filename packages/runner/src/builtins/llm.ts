import {
  DEFAULT_GENERATE_OBJECT_MODELS,
  DEFAULT_MODEL_NAME,
  LLMClient,
  LLMGenerateObjectRequest,
  LLMMessage,
  LLMRequest,
  LLMToolCall,
} from "@commontools/llm";
import {
  BuiltInGenerateObjectParams,
  BuiltInLLMParams,
  BuiltInLLMState,
} from "@commontools/api";
import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

const client = new LLMClient();

// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param messages - list of messages to send to the LLM. - alternating user and assistant messages.
 *  - if you end with an assistant message, the LLM will continue from there.
 *  - if both prompt and messages are empty, no LLM call will be made,
 *    result and partial will be undefined.
 * @param model - A doc to store the model to use.
 * @param system - A doc to store the system message.
 * @param stop - A doc to store (optional) stop sequence.
 * @param maxTokens - A doc to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, result?: string, partial?: string } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llm(
  inputsCell: Cell<BuiltInLLMParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<string | undefined>;
  let partial: Cell<string | undefined>;
  let requestHash: Cell<string | undefined>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell(
        parentCell.space,
        { llm: { pending: cause } },
        undefined,
        tx,
      );
      pending.send(false);

      result = runtime.getCell<string | undefined>(
        parentCell.space,
        {
          llm: { result: cause },
        },
        undefined,
        tx,
      );

      partial = runtime.getCell<string | undefined>(
        parentCell.space,
        {
          llm: { partial: cause },
        },
        undefined,
        tx,
      );

      requestHash = runtime.getCell<string | undefined>(
        parentCell.space,
        {
          llm: { requestHash: cause },
        },
        undefined,
        tx,
      );

      sendResult(tx, { pending, result, partial, requestHash });
      cellsInitialized = true;
    }
    const thisRun = ++currentRun;
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const partialWithLog = partial.withTx(tx);
    const requestHashWithLog = requestHash.withTx(tx);

    const { system, messages, stop, maxTokens, model, tools } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    const llmParams: LLMRequest = {
      system: system ?? "",
      messages: messages ?? [],
      stop: stop ?? "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        // FIXME(ja): how do we get the context of space/charm id here
        // bf: I also do not know... this one is tricky
        context: "charm",
      },
      cache: true,
      tools: tools, // Pass through tools if provided
    };

    const hash = refer(llmParams).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash || hash === requestHashWithLog.get()) return;
    previousCallHash = hash;

    resultWithLog.set(undefined);
    partialWithLog.set(undefined);

    if (!Array.isArray(messages) || messages.length === 0) {
      pendingWithLog.set(false);
      return;
    }
    pendingWithLog.set(true);

    const updatePartial = (text: string) => {
      if (thisRun != currentRun) return;
      // TODO(bf): we should consider an `asyncTx` pattern here akin to `stream-data.ts`
      const status = tx.status();
      if (status.status !== "ready") return;

      partialWithLog.set(text);
    };

    const resultPromise = client.sendRequest(llmParams, updatePartial);

    resultPromise
      .then(async (llmResult) => {
        if (thisRun !== currentRun) return;

        let text = llmResult.content;
        let finalMessages: LLMMessage[] = [...(messages ?? [])];

        // Handle tool calls if present
        if (llmResult.toolCalls && llmResult.toolCalls.length > 0 && tools) {
          // Add assistant message with tool calls to conversation
          finalMessages.push({
            role: "assistant",
            content: text,
            toolCalls: llmResult.toolCalls
          });

          // Execute each tool call
          for (const toolCall of llmResult.toolCalls) {
            const toolDef = tools[toolCall.name];
            if (!toolDef?.handler) {
              console.warn(`No handler found for tool: ${toolCall.name}`);
              // Add error result
              finalMessages.push({
                role: "tool",
                content: JSON.stringify({ error: `No handler for tool: ${toolCall.name}` }),
                toolCallId: toolCall.id
              });
              continue;
            }

            try {
              // Execute the tool handler
              const result = await toolDef.handler(toolCall.arguments);
              
              // Add tool result to conversation
              finalMessages.push({
                role: "tool",
                content: JSON.stringify(result),
                toolCallId: toolCall.id
              });
              
              console.log(`Tool ${toolCall.name} executed successfully:`, result);
            } catch (error) {
              console.error(`Tool ${toolCall.name} execution failed:`, error);
              
              // Add error result
              finalMessages.push({
                role: "tool",
                content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                toolCallId: toolCall.id
              });
            }
          }

          // Continue conversation with tool results by making another LLM call
          const continuationParams: LLMRequest = {
            ...llmParams,
            messages: finalMessages
          };

          // Make continuation call
          const continuationResult = await client.sendRequest(continuationParams, updatePartial);
          text = continuationResult.content;
        }

        await runtime.idle();

        // All this code runside outside the original action, and the
        // transaction above might have closed by the time this is called. If
        // so, we create a new one to set the result.
        const status = tx.status();
        const asyncTx = status.status === "ready" ? tx : runtime.edit();

        pendingWithLog.withTx(asyncTx).set(false);
        resultWithLog.withTx(asyncTx).set(text);
        partialWithLog.withTx(asyncTx).set(text);
        requestHashWithLog.withTx(asyncTx).set(hash);

        if (asyncTx !== tx) asyncTx.commit();
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating data", error);

        await runtime.idle();

        // All this code runside outside the original action, and the
        // transaction above might have closed by the time this is called. If
        // so, we create a new one to set the result.
        const status = tx.status();
        const asyncTx = status.status === "ready" ? tx : runtime.edit();

        pendingWithLog.withTx(asyncTx).set(false);
        resultWithLog.withTx(asyncTx).set(undefined);
        partialWithLog.withTx(asyncTx).set(undefined);

        if (asyncTx !== tx) asyncTx.commit();

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}

/**
 * Generate structured data via an LLM using JSON mode.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param prompt - The prompt to send to the LLM.
 * @param schema - JSON Schema to validate the response against.
 * @param system - Optional system message.
 * @param maxTokens - Maximum number of tokens to generate.
 * @param model - Model to use (defaults to DEFAULT_GENERATE_OBJECT_MODELS).
 * @param cache - Whether to cache the response (defaults to true).
 * @param metadata - Additional metadata to pass to the LLM.
 *
 * @returns { pending: boolean, result?: object, partial?: string } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function generateObject<T extends Record<string, unknown>>(
  inputsCell: Cell<BuiltInGenerateObjectParams>,
  sendResult: (tx: IExtendedStorageTransaction, docs: {
    pending: Cell<boolean>;
    result: Cell<T | undefined>;
    partial: Cell<string | undefined>;
    requestHash: Cell<string | undefined>;
  }) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<T | undefined>;
  let partial: Cell<string | undefined>;
  let requestHash: Cell<string | undefined>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell<boolean>(
        parentCell.space,
        { generateObject: { pending: cause } },
        undefined,
        tx,
      );
      pending.send(false);

      result = runtime.getCell<T | undefined>(
        parentCell.space,
        {
          generateObject: { result: cause },
        },
        undefined,
        tx,
      );

      partial = runtime.getCell<string | undefined>(
        parentCell.space,
        {
          generateObject: { partial: cause },
        },
        undefined,
        tx,
      );

      requestHash = runtime.getCell<string | undefined>(
        parentCell.space,
        {
          generateObject: { requestHash: cause },
        },
        undefined,
        tx,
      );

      sendResult(tx, { pending, result, partial, requestHash });
      cellsInitialized = true;
    }
    const thisRun = ++currentRun;
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const partialWithLog = partial.withTx(tx);
    const requestHashWithLog = requestHash.withTx(tx);

    const { prompt, maxTokens, model, schema, system, cache, metadata } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    if (!prompt || !schema) {
      pendingWithLog.set(false);
      return;
    }

    const readyMetadata = metadata ? JSON.parse(JSON.stringify(metadata)) : {};

    const generateObjectParams: LLMGenerateObjectRequest = {
      prompt,
      maxTokens: maxTokens ?? 8192,
      schema: JSON.parse(JSON.stringify(schema)),
      model: model ?? DEFAULT_GENERATE_OBJECT_MODELS,
      metadata: {
        ...readyMetadata,
        context: "charm",
      },
      cache: cache ?? true,
    };

    if (system) {
      generateObjectParams.system = system;
    }

    const hash = refer(generateObjectParams).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash || hash === requestHashWithLog.get()) return;
    previousCallHash = hash;

    resultWithLog.set({} as any); // FIXME(ja): setting result to undefined causes a storage conflict
    partialWithLog.set(undefined);
    pendingWithLog.set(true);

    const resultPromise = client.generateObject(
      generateObjectParams,
    ) as Promise<{
      object: T;
    }>;

    resultPromise
      .then(async (response) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        // All this code runside outside the original action, and the
        // transaction above might have closed by the time this is called. If
        // so, we create a new one to set the result.
        const status = tx.status();
        const asyncTx = status.status === "ready" ? tx : runtime.edit();

        pendingWithLog.withTx(asyncTx).set(false);
        resultWithLog.withTx(asyncTx).set(response.object);
        requestHashWithLog.withTx(asyncTx).set(hash);

        if (asyncTx !== tx) asyncTx.commit();
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating object", error);

        await runtime.idle();

        // All this code runside outside the original action, and the
        // transaction above might have closed by the time this is called. If
        // so, we create a new one to set the result.
        const status = tx.status();
        const asyncTx = status.status === "ready" ? tx : runtime.edit();

        pendingWithLog.withTx(asyncTx).set(false);
        resultWithLog.withTx(asyncTx).set({} as any); // FIXME(ja): setting result to undefined causes a storage conflict
        partialWithLog.withTx(asyncTx).set(undefined);

        if (asyncTx !== tx) asyncTx.commit();

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}
