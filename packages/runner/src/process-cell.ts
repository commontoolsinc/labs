import type { Cell } from "./cell.ts";
import type { Schema } from "./builder/types.ts";
import { processLinkSchema } from "./schemas.ts";
import { parseLink } from "./link-utils.ts";
import { URI } from "./sigil-types.ts";

export function getPatternIdFromSourceCell(
  sourceCell: Cell<Schema<typeof processLinkSchema>>,
): URI | undefined {
  const patternValue = sourceCell.key("pattern").getRaw() ??
    sourceCell.key("spell").getRaw();
  return parseLink(patternValue, sourceCell)?.id;
}

export function getPatternIdFromResultCell(
  resultCell: Cell<unknown>,
): URI | undefined {
  const sourceCell = resultCell.getSourceCell(processLinkSchema);
  return sourceCell ? getPatternIdFromSourceCell(sourceCell) : undefined;
}
