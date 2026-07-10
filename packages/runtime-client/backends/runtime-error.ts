import { CompilerStackLoadError } from "../../runner/src/harness/deferred-compiler-stack.ts";
import { NotificationType, RuntimeErrorCode } from "../protocol/mod.ts";

function runtimeErrorCode(error: Error): RuntimeErrorCode | undefined {
  return error instanceof CompilerStackLoadError
    ? RuntimeErrorCode.CompilerStackLoadFailed
    : undefined;
}

/** Post an asynchronous renderer error to the shell. */
export function postRuntimeError(error: Error): void {
  const code = runtimeErrorCode(error);
  self.postMessage({
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
  self.postMessage({
    type: NotificationType.ErrorReport,
    message: error.message,
    ...(code ? { code } : {}),
    pageId: error.pieceId,
    space: error.space,
    patternId: error.patternId,
    spellId: error.spellId,
    stackTrace: error.stack,
  });
}
