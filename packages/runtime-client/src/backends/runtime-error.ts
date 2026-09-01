import { CompilerStackLoadError } from "@commonfabric/runner";
import {
  type ErrorNotification,
  NotificationType,
  RuntimeErrorCode,
} from "@/protocol/mod.ts";
import { postToClient } from "./post-to-client.ts";

function runtimeErrorCode(error: Error): RuntimeErrorCode | undefined {
  return error instanceof CompilerStackLoadError
    ? RuntimeErrorCode.CompilerStackLoadFailed
    : undefined;
}

/**
 * The report an asynchronous renderer error crosses as. Built rather than
 * posted, so that a caller holding one client of several sends it to that
 * client instead of to the worker's own global.
 */
export function runtimeErrorPost(error: Error): ErrorNotification {
  const code = runtimeErrorCode(error);
  return {
    type: NotificationType.ErrorReport,
    message: error.message,
    ...(code ? { code } : {}),
    stackTrace: error.stack,
  };
}

/** Post an asynchronous renderer error to the shell. */
export function postRuntimeError(error: Error): void {
  postToClient(runtimeErrorPost(error));
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
