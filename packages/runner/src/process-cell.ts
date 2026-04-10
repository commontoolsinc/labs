import type { Cell } from "./cell.ts";
import type { Schema } from "./builder/types.ts";
import { processLinkSchema } from "./schemas.ts";

function getPatternCellFromSourceCell(
  sourceCell: Cell<Schema<typeof processLinkSchema>>,
) {
  return sourceCell.key("pattern").get() ?? sourceCell.key("spell").get();
}

export function getPatternIdFromSourceCell(
  sourceCell: Cell<Schema<typeof processLinkSchema>>,
): string | undefined {
  return getPatternCellFromSourceCell(sourceCell)?.sourceURI;
}

export function getPatternIdFromPiece(
  piece: Cell<unknown>,
): string | undefined {
  const sourceCell = piece.getSourceCell(processLinkSchema);
  return sourceCell ? getPatternIdFromSourceCell(sourceCell) : undefined;
}
