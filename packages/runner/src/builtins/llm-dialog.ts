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
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let requestHash: Cell<string | undefined>;
  let addMessage: Cell<BuiltInLLMMessage | undefined>;
  const messagesCell = inputsCell.key("messages");

  const action = (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell(
        parentCell.space,
        { llm: { pending: cause } },
        undefined,
        tx,
      );
      pending.send(false);

      requestHash = runtime.getCell<string | undefined>(
        parentCell.space,
        {
          llm: { requestHash: cause },
        },
        undefined,
        tx,
      );

      // Declare `addMessage` handler and register
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
        // check pending
        if (pending.withTx(tx).get()) {
          // ignore
          return;
        }

        pending.withTx(tx).set(true);
        messagesCell.withTx(tx).set([
          ...(messagesCell.get() ?? []),
          event,
        ]);

        mainLogic(tx, runtime, parentCell, inputsCell, pending);
      };

      addCancel(
        runtime.scheduler.addEventHandler(handler, addMessageStreamLink),
      );

      sendResult(tx, {
        pending,
        requestHash,
        addMessage,
      });
      cellsInitialized = true;
    }
  };

  return action;
}

function mainLogic(
  tx: IExtendedStorageTransaction,
  runtime: IRuntime,
  parentCell: Cell<any>,
  inputsCell: Cell<BuiltInLLMParams>,
  pending: Cell<boolean>,
) {
  // consider: do we need to pass in tx? we shall see
  const { system, stop, maxTokens, model } = inputsCell.getAsQueryResult([], tx) ??
    {};

  const messagesCell = inputsCell.key("messages");

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

  // Case should not occur anymore, since event handler is the only invocation path
  // if (!Array.isArray(messages) || messages.length === 0) {
  //   pendingWithLog.set(false);
  //   return;
  // }

  // // If the last message is from the assistant, no LLM request needed
  // const lastMessage = messages[messages.length - 1];
  // if (lastMessage && lastMessage.role === "assistant") {
  //   pendingWithLog.set(false);
  //   // Set the result to the last assistant message content
  //   const content = typeof lastMessage.content === "string"
  //     ? lastMessage.content
  //     : "";
  //   requestHashWithLog.set(hash);
  //   return;
  // }

  // Only clear result/partial when we're about to make a new request
  // pendingWithLog.set(true);

  const updatePartial = (text: string) => {
    // no-op, but we need a callback
  };

  const resultPromise = client.sendRequest(llmParams, updatePartial);

  resultPromise
    .then(async (llmResult) => {
      const text = llmResult.content;

      // If there are tool calls, prevent re-entry and execute them atomically
      if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
        try {
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
              const handlerTx = runtime.edit();
              const result = runtime.getCell<any>(
                parentCell.space,
                toolCall.id,
                undefined,
                handlerTx,
              );

              const { resolve, promise } = Promise.withResolvers<any>();

              const handlerCell = toolDef.key("handler");
              handlerCell.withTx(handlerTx).send({
                ...toolCall.arguments,
                result,
              } as any); // TODO(bf): why any needed?

              // wait until we know we have the result of the tool call, not just that the transaction has been comitted
              const cancel = result.sink((r) => {
                r !== undefined && resolve(r);
              });
              handlerTx.commit();

              const resultValue = await promise;
              cancel();

              if (true) {
                const tx = runtime.edit();
                // this is probably a proxy, so it may still update in the conversation history reactively later
                toolResults.push({
                  id: toolCall.id,
                  result: resultValue,
                });
              }
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

          // TODO(bf): fix repeated block
          if (true) {
            const newTx = messagesCell.runtime.edit();
            if (pending.withTx(newTx).get()) {
              messagesCell.withTx(newTx).set([
                ...(messagesCell.get() ?? []),
                ...newMessages,
              ]);
              newTx.commit();
            } else {
              // no op
            }
          }
        } catch (error: unknown) {
          console.error(error);
        }
      } else {
        // No tool calls, just add the assistant message
        const assistantMessage: BuiltInLLMMessage = {
          role: "assistant",
          content: llmResult.content,
        };

        if (true) {
          const newTx = messagesCell.runtime.edit();
          messagesCell.withTx(newTx).set([
            ...(messagesCell.get() ?? []),
            assistantMessage,
          ]);
          pending.withTx(newTx).set(false);
          newTx.commit();
        }
      }
    })
    .catch((error: unknown) => {
      console.error("Error generating data", error);
      const tx = runtime.edit();
      pending.withTx(tx).set(false);
      tx.commit();
    });
}
