import {
  DEFAULT_GENERATE_OBJECT_MODELS,
  DEFAULT_MODEL_NAME,
  LLMClient,
  LLMGenerateObjectRequest,
  LLMRequest,
  LLMToolCall,
} from "@commontools/llm";
import {
  BuiltInGenerateObjectParams,
  BuiltInLLMDialogState,
  BuiltInLLMMessage,
  BuiltInLLMParams,
  BuiltInLLMTool,
} from "@commontools/api";
import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { parseLink } from "../link-utils.ts";

const client = new LLMClient();

// Default token limits
const DEFAULT_LLM_MAX_TOKENS = 4096;
const DEFAULT_GENERATE_OBJECT_MAX_TOKENS = 8192;

// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

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
  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let requestHash: Cell<string | undefined>;
  let addMessage: Cell<BuiltInLLMMessage | undefined>;
  let isExecutingTools = false;
  const messagesCell = inputsCell.key("messages");

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

      addMessage = runtime.getCell<BuiltInLLMMessage | undefined>(
        parentCell.space,
        {
          llm: { addMessage: cause },
        },
        undefined,
        tx,
      );
      addMessage.setRaw({ $stream: true });

      const addMessageStreamLink = parseLink(addMessage);
      const handler = (
        tx: IExtendedStorageTransaction,
        event: BuiltInLLMMessage,
      ) => {
        messagesCell.withTx(tx).set([
          ...(messagesCell.get() ?? []),
          event,
        ]);
      };

      addCancel(
        runtime.scheduler.addEventHandler(handler, addMessageStreamLink),
      );

      sendResult(tx, {
        pending,
        result,
        partial,
        requestHash,
        addMessage,
      });
      cellsInitialized = true;
    }
    const thisRun = ++currentRun;
    const pendingWithLog = pending.withTx(tx);
    const requestHashWithLog = requestHash.withTx(tx);

    const { system, stop, maxTokens, model } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    const messages = messagesCell.getAsQueryResult([], tx) ?? [];
    const toolsCell = inputsCell.key("tools");

    // Strip handlers from tool definitions to send them to the server
    // We keep the handlers locally and execute them here
    const toolsWithoutHandlers = Object.fromEntries(
      Object.entries(toolsCell.get() ?? {}).map(([name, tool]) => {
        const { handler, ...toolWithoutHandler } = tool;
        return [name, toolWithoutHandler];
      }),
    );

    const llmParams: LLMRequest = {
      system: system ?? "",
      messages: messages ?? [],
      stop: stop ?? "",
      maxTokens: maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        // FIXME(ja): how do we get the context of space/charm id here
        // bf: I also do not know... this one is tricky
        context: "charm",
      },
      cache: true,
      tools: toolsWithoutHandlers, // Pass through tools if provided
    };

    // Prevent re-entry while tools are executing to avoid race condition
    if (isExecutingTools) return;

    const hash = refer(llmParams).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash || hash === requestHashWithLog.get()) return;
    previousCallHash = hash;

    if (!Array.isArray(messages) || messages.length === 0) {
      pendingWithLog.set(false);
      return;
    }

    // If the last message is from the assistant, no LLM request needed
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === "assistant") {
      pendingWithLog.set(false);
      // Set the result to the last assistant message content
      const content = typeof lastMessage.content === "string"
        ? lastMessage.content
        : "";
      requestHashWithLog.set(hash);
      return;
    }

    // Only clear result/partial when we're about to make a new request
    pendingWithLog.set(true);

    const updatePartial = (text: string) => {
      // no-op, but we need a callback
    };

    const resultPromise = client.sendRequest(llmParams, updatePartial);

    resultPromise
      .then(async (llmResult) => {
        if (thisRun !== currentRun) return;

        const text = llmResult.content;

        // If there are tool calls, prevent re-entry and execute them atomically
        if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
          isExecutingTools = true;

          try {
            const newTx = messagesCell.runtime.edit();
            const newMessages: BuiltInLLMMessage[] = [];

            // Add assistant message with tool calls to conversation
            const assistantMessage: BuiltInLLMMessage = {
              role: "assistant",
              content: llmResult.content,
              toolCalls: llmResult.toolCalls,
            };

            // Execute each tool call and collect results
            const toolResults: any[] = [];
            for (const toolCall of llmResult.toolCalls) {
              const toolDef = toolsCell.key(toolCall.name) as Cell<
                BuiltInLLMTool
              >;

              try {
                const result = runtime.getCell<any>(
                  parentCell.space,
                  {
                    toolResult: { [toolCall.id]: cause },
                  },
                  undefined,
                  newTx,
                );

                const handlerTx = runtime.edit();
                const handlerCell = toolDef.key("handler");
                handlerCell.withTx(handlerTx).send({
                  ...toolCall.arguments,
                  result,
                } as any); // TODO(bf): why any needed?
                await handlerTx.commit();

                toolResults.push({
                  id: toolCall.id,
                  result,
                });
              } catch (error) {
                console.error(`Tool ${toolCall.name} failed:`, error);
                toolResults.push({
                  id: toolCall.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            // Update the assistant message to include tool results
            assistantMessage.toolResults = toolResults;
            newMessages.push(assistantMessage);

            // Update messages in cell with new messages AFTER all tools complete
            messagesCell.withTx(newTx).set([
              ...(messagesCell.get() ?? []),
              ...newMessages,
            ]);
            await newTx.commit();
          } finally {
            // Always clear the flag, even if tool execution fails
            isExecutingTools = false;
          }
        } else {
          // No tool calls, just add the assistant message
          const newTx = messagesCell.runtime.edit();
          const assistantMessage: BuiltInLLMMessage = {
            role: "assistant",
            content: llmResult.content,
          };
          messagesCell.withTx(newTx).set([
            ...(messagesCell.get() ?? []),
            assistantMessage,
          ]);
          await newTx.commit();
        }

        await runtime.idle();

        // All this code runside outside the original action, and the
        // transaction above might have closed by the time this is called. If
        // so, we create a new one to set the result.
        const status = tx.status();
        const asyncTx = status.status === "ready" ? tx : runtime.edit();

        pendingWithLog.withTx(asyncTx).set(false);
        requestHashWithLog.withTx(asyncTx).set(hash);

        if (asyncTx !== tx) asyncTx.commit();
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        // Ensure flag is cleared even on error
        isExecutingTools = false;

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
