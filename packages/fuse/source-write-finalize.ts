import type { PatternUpdateReceipt } from "@commonfabric/piece/ops";

/**
 * The sentence a committed source update reports when later work fails: the
 * durable outcome first — the revision and the pattern pointer it committed —
 * then the failure that did not undo it.
 */
export function committedSourceWarning(
  receipt: PatternUpdateReceipt,
  failure: string,
): string {
  return `Source revision ${receipt.revisionId} committed as ` +
    `cf:module/${receipt.ref.identity}#${receipt.ref.symbol}, but ${failure}`;
}

/**
 * Run local FUSE projection work after a source transaction has committed.
 *
 * A failure here cannot undo the receipt and therefore must not reject the
 * filesystem write. Returning it as a warning keeps the durable outcome and
 * the local projection outcome separate at the same boundary as Piece does.
 */
export async function finalizeCommittedSourceWrite(
  receipt: PatternUpdateReceipt,
  finalize: () => Promise<void>,
) {
  try {
    await finalize();
    return { status: "completed" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed" as const,
      warning: committedSourceWarning(
        receipt,
        `refreshing the FUSE projection failed: ${message}`,
      ),
      error,
    };
  }
}
