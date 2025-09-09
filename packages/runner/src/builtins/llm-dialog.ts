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

/**
 * Performs a mutation on the storage if the pending flag is active.
 * This ensures the pending flag has final say over whether the LLM continues generating.
 *
 * @param runtime - The runtime instance
 * @param pending - Cell containing the pending state
 * @param action - The mutation action to perform if pending is true
 * @returns true if the action was performed, false otherwise
 */
function perform(
  runtime: IRuntime,
  pending: Cell<boolean>,
  action: (tx: IExtendedStorageTransaction) => void,
) {
  const tx = runtime.edit();
  if (pending.withTx(tx).get()) {
    action(tx);
    // TODO(bf): [CT-859] when we support continuations, call mainLogc() again here
    tx.commit();
    return true;
  }

  return false;
}

/**
 * Executes a tool call by invoking its handler function and returning the result.
 * Creates a new transaction, sends the tool call arguments to the handler, and waits
 * for the result to be available before returning it.
 *
 * @param runtime - The runtime instance for creating transactions and cells
 * @param parentCell - The parent cell context for the tool execution
 * @param toolDef - Cell containing the tool definition with handler
 * @param toolCall - The LLM tool call containing id, name, and arguments
 * @returns Promise that resolves to the tool execution result
 */
async function invokeHandlerAsToolCall(
  runtime: IRuntime,
  parentCell: Cell<any>,
  toolDef: Cell<BuiltInLLMTool>,
  toolCall: LLMToolCall,
) {
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

  // wait until we know we have the result of the tool call
  // not just that the transaction has been comitted
  const cancel = result.sink((r) => {
    r !== undefined && resolve(r);
  });
  handlerTx.commit();
  const resultValue = await promise;
  cancel();

  return resultValue;
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
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let addMessage: Cell<BuiltInLLMMessage | undefined>;
  const messagesCell = inputsCell.key("messages");

  return (tx: IExtendedStorageTransaction) => {
    // SETUP CODE
    if (!cellsInitialized) {
      pending = runtime.getCell(
        parentCell.space,
        { llm: { pending: cause } },
        undefined,
        tx,
      );
      pending.send(false);

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
        addMessage,
      });
      cellsInitialized = true;
    }
  };
}

function mainLogic(
  tx: IExtendedStorageTransaction,
  runtime: IRuntime,
  parentCell: Cell<any>,
  inputsCell: Cell<BuiltInLLMParams>,
  pending: Cell<boolean>,
) {
  const { system, stop, maxTokens, model } =
    inputsCell.getAsQueryResult([], tx) ??
      {};

  const messagesCell = inputsCell.key("messages");
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
    messages: messagesCell.getAsQueryResult([], tx) ?? [],
    stop: stop ?? "",
    maxTokens: maxTokens,
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

  // TODO(bf): sendRequest must be given a callback, even if it does nothing
  const resultPromise = client.sendRequest(llmParams, () => {});

  resultPromise
    .then(async (llmResult) => {
      if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
        try {
          const newMessages: BuiltInLLMMessage[] = [];

          // Create assistant message with tool-call content parts
          const assistantContentParts: Array<
            BuiltInLLMTextPart | BuiltInLLMToolCallPart
          > = [];

          // Add text content if present
          if (llmResult.content) {
            assistantContentParts.push({
              type: "text",
              text: llmResult.content,
            });
          }

          // Add tool call parts
          for (const toolCall of llmResult.toolCalls) {
            assistantContentParts.push({
              type: "tool-call",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: toolCall.arguments,
            });
          }

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
              const resultValue = await invokeHandlerAsToolCall(
                runtime,
                parentCell,
                toolDef,
                toolCall,
              );
              // this is probably a proxy, so it may still update in the conversation history reactively later
              // but we intend this to be a static / snapshot at this stage
              toolResults.push({
                id: toolCall.id,
                result: resultValue,
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

          const success = perform(runtime, pending, (tx) => {
            messagesCell.withTx(tx).set([
              ...(messagesCell.get() ?? []),
              ...newMessages,
            ]);
            pending.withTx(tx).set(false);
          });

          if (success) {
            // Support continuations - call mainLogic() again for chained tool calls
            // The LLM will see the tool results and can make additional tool calls
            console.log("Continuing conversation after tool calls...");

            // Create a new transaction for the continuation
            const continueTx = runtime.edit();
            mainLogic(continueTx, runtime, parentCell, inputsCell, pending);
            continueTx.commit();
          } else {
            console.info("Did not write to conversation due to pending=false");
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

        const tx = runtime.edit();
        messagesCell.withTx(tx).set([
          ...(messagesCell.get() ?? []),
          assistantMessage,
        ]);
        pending.withTx(tx).set(false);
        tx.commit();
      }
    })
    .catch((error: unknown) => {
      console.error("Error generating data", error);
      const tx = runtime.edit();
      pending.withTx(tx).set(false);
      tx.commit();
    });
}
