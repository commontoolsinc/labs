import type { PatternUpdateReceipt } from "@commonfabric/piece/ops";

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
      warning: `Source revision ${receipt.revisionId} committed as ` +
        `cf:module/${receipt.ref.identity}#${receipt.ref.symbol}, but ` +
        `refreshing the FUSE projection failed: ${message}`,
      error,
    };
  }
}
