import { CompilerStackLoadError } from "@commonfabric/runner";
import { NotificationType, RuntimeErrorCode } from "@/protocol/mod.ts";
import { postToClient } from "./post-to-client.ts";

function runtimeErrorCode(error: Error): RuntimeErrorCode | undefined {
  return error instanceof CompilerStackLoadError
    ? RuntimeErrorCode.CompilerStackLoadFailed
    : undefined;
}

/** Post an asynchronous renderer error to the shell. */
export function postRuntimeError(error: Error): void {
  const code = runtimeErrorCode(error);
  postToClient({
    type: NotificationType.ErrorReport,
    message: error.message,
    ...(code ? { code } : {}),
    stackTrace: error.stack,
  });
}

type ContextualRuntimeError = Error & {
  pieceId?: string;
  space?: string;
  patternId?: string;
  spellId?: string;
};

/** Post a runner error together with its pattern context. */
export function postContextualRuntimeError(
  error: ContextualRuntimeError,
): void {
  const code = runtimeErrorCode(error);
  postToClient({
    type: NotificationType.ErrorReport,
    message: error.message,
    ...(code ? { code } : {}),
    pieceId: error.pieceId,
    space: error.space,
    patternId: error.patternId,
    spellId: error.spellId,
    stackTrace: error.stack,
  });
}
