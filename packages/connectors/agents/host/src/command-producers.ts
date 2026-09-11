import { stableCellId } from "@commonfabric/agents-connector";
import type { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import type { PiecesController } from "@commonfabric/piece/ops";
import { commandWriterAuthorization } from "./command-authorization.ts";
import type { CommandProducerConfig } from "./config.ts";

/** A producer pattern the host accepts commands from, and its queue. */
export interface BoundCommandProducer {
  id: string;
  piece: string;
  commandCellId: string;
}

/**
 * Binds one command queue per configured producer and links each queue into
 * its producer piece's `commands` input. A producer is a deployed piece whose
 * pattern declares `commandAuthorization`, the verified handler that may
 * write its queue; the queue is protected for the owner with that handler as
 * its only writer, so the piece can send commands and nothing else can.
 */
export async function bindCommandProducers(
  manager: PiecesController,
  target: AgentFabricTarget,
  producers: readonly CommandProducerConfig[],
  signal?: AbortSignal,
): Promise<BoundCommandProducer[]> {
  const bound: BoundCommandProducer[] = [];
  for (const producer of producers) {
    signal?.throwIfAborted();
    const piece = await manager.get(producer.piece);
    const pattern = await piece.getPattern();
    const authorization = commandWriterAuthorization(pattern);
    if (authorization === undefined) {
      throw new Error(
        `command producer ${producer.id} declares no verified command writer authorization`,
      );
    }
    signal?.throwIfAborted();
    const cell = await target.bindProducerCommandCell(
      producer.id,
      authorization,
    );
    const commandCellId = stableCellId(cell.resolveAsCell());
    signal?.throwIfAborted();
    await manager.link(commandCellId, [], producer.piece, ["commands"], {
      start: false,
    });
    bound.push({ id: producer.id, piece: producer.piece, commandCellId });
  }
  return bound;
}
