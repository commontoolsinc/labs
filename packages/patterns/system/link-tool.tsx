/// <cts-enable />
import { type Cell, Writable, handler, NAME } from "commontools";
import { MentionableCharm } from "./backlinks-index.tsx";

/**
 * Parse a path like "CharmName/result/field" or "CharmName/input/field"
 */
function parsePath(path: string): {
  charmName: string;
  cellType?: "result" | "input";
  path: (string | number)[];
} {
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(`Invalid path: "${path}"`);
  }

  const charmName = segments[0];
  const rest = segments.slice(1);

  // Check if second segment is "result" or "input"
  if (rest.length > 0 && (rest[0] === "result" || rest[0] === "input")) {
    return {
      charmName,
      cellType: rest[0],
      path: rest.slice(1),
    };
  }

  return { charmName, path: rest };
}

/**
 * Find a charm by name from the mentionable list
 */
function findCharmByName(
  mentionable: Writable<MentionableCharm[]>,
  name: string,
): Writable<MentionableCharm> | undefined {
  for (let i = 0; i < mentionable.get().length; i++) {
    const c = mentionable.key(i);
    if (c.get()[NAME] === name) {
      return c;
    }
  }

  return undefined;
}

/**
 * Navigate through a path of keys/indices on a cell
 */
function navigateToCell(
  cell: Writable<any>,
  path: readonly (string | number)[],
): Writable<any> {
  let current = cell;
  for (const segment of path) {
    current = current.key(segment);
  }
  return current;
}

/**
 * Handler for creating links between charm cells.
 * Used by chatbot.tsx to enable LLM-driven cell linking.
 *
 * Supports paths like:
 *   - "CharmName/result/field" - link from charm result
 *   - "CharmName/input/field"  - link to/from charm input
 *   - "CharmName/field"        - defaults to result
 */
export const linkTool = handler<
  { source: string; target: string },
  { mentionable: Writable<MentionableCharm[]> }
>(({ source, target }, { mentionable }) => {
  const sourceParsed = parsePath(source);
  const targetParsed = parsePath(target);

  // Find source and target charms
  const sourceCharm = findCharmByName(mentionable, sourceParsed.charmName);
  if (!sourceCharm) {
    const names = mentionable
      .map((c) => c[NAME])
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Source charm "${sourceParsed.charmName}" not found. Available: ${
        names || "none"
      }`,
    );
  }

  const targetCharm = findCharmByName(mentionable, targetParsed.charmName);
  if (!targetCharm) {
    const names = mentionable
      .map((c) => c[NAME])
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Target charm "${targetParsed.charmName}" not found. Available: ${
        names || "none"
      }`,
    );
  }

  // Navigate to source cell
  let sourceCell: Writable<any> = sourceCharm;
  if (sourceParsed.cellType === "input") {
    const argCell = sourceCharm.resolveAsCell().getArgumentCell();
    if (!argCell) throw new Error("Source charm has no argument cell");
    sourceCell = argCell;
  }
  sourceCell = navigateToCell(sourceCell, sourceParsed.path);

  // Navigate to target cell
  let targetCell: Writable<any> = targetCharm;
  if (targetParsed.cellType === "input" || targetParsed.path.length > 0) {
    // For any path or explicit "input", navigate to argument cell
    const argCell = targetCharm.resolveAsCell().getArgumentCell();
    if (!argCell) throw new Error("Target charm has no argument cell");
    targetCell = argCell;
  }

  // Pop last segment as the key to set
  const targetPath = [...targetParsed.path];
  const targetKey = targetPath.pop();
  if (targetKey === undefined) {
    throw new Error("Target path cannot be empty");
  }

  // Navigate to parent and set link
  const targetParent = navigateToCell(targetCell, targetPath);
  targetParent.key(targetKey).set(sourceCell);
});
