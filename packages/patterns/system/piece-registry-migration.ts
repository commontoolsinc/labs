import { type Writable } from "commonfabric";

export const migratePieceRegistry = <T>(
  legacyPieceRegistry: Writable<T[]>,
  pieceRegistry: Writable<T[]>,
  migrationComplete: Writable<boolean>,
) => {
  if (migrationComplete.get()) return;
  const legacyPieces = legacyPieceRegistry.get();
  if (legacyPieces.length > 0 && pieceRegistry.get().length === 0) {
    pieceRegistry.set([...legacyPieces]);
  }
  migrationComplete.set(true);
};
