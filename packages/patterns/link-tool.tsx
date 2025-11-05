/// <cts-enable />
import {
  Cell,
  cell,
  derive,
  handler,
  NAME,
  recipe,
  UI,
  wish,
} from "commontools";

/**
 * Parsed path components
 */
type ParsedPath = {
  charmName: string;
  cellType?: "result" | "input"; // Optional for backward compatibility
  path: string[];
};

/**
 * Parse a slash-separated path into components
 * Supports formats like:
 * - "CharmName/result/field"
 * - "CharmName/input/field"
 * - "CharmName/field" (no cellType specified)
 */
function parsePath(pathString: string): ParsedPath {
  const trimmed = pathString.trim();
  if (!trimmed) {
    throw new Error("Path cannot be empty");
  }

  // Remove leading slash if present
  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const segments = normalized.split("/").filter((s) => s.length > 0);

  if (segments.length === 0) {
    throw new Error("Path must have at least one segment (charm name)");
  }

  const charmName = segments[0];
  let cellType: "result" | "input" | undefined;
  let path: string[];

  // Check if second segment is a cell type keyword
  if (segments.length > 1 && (segments[1] === "result" || segments[1] === "input")) {
    cellType = segments[1];
    path = segments.slice(2);
  } else {
    // No explicit cell type, use remaining segments as path
    path = segments.slice(1);
  }

  return { charmName, cellType, path };
}

/**
 * Find a charm by name with fuzzy matching
 */
function findCharmByName(charms: Array<any>, name: string): any | undefined {
  if (!Array.isArray(charms) || charms.length === 0) {
    return undefined;
  }

  // Exact match first
  const exact = charms.find((c) => c[NAME] === name);
  if (exact) return exact;

  // Case-insensitive match
  const lowerName = name.toLowerCase();
  const caseInsensitive = charms.find(
    (c) => c[NAME]?.toLowerCase() === lowerName,
  );
  if (caseInsensitive) return caseInsensitive;

  // Partial match (contains)
  const partial = charms.find(
    (c) => c[NAME]?.toLowerCase().includes(lowerName),
  );
  return partial;
}

/**
 * Navigate to a cell given a charm and path segments
 */
function navigateToCell(charm: Cell<any>, segments: string[]): Cell<any> {
  let current: Cell<any> = charm;
  for (const segment of segments) {
    current = current.key(segment);
  }
  return current;
}

/**
 * Handler to create a link between two charm cells
 */
const createLink = handler<
  {
    source: string;
    target: string;
    result?: Cell<string>;
  },
  {
    charms: Array<any>;
  }
>(({ source, target, result }, { charms }) => {
  try {
    // Parse both paths
    const sourceParsed = parsePath(source);
    const targetParsed = parsePath(target);

    // Find source charm
    const sourceCharm = findCharmByName(charms, sourceParsed.charmName);
    if (!sourceCharm) {
      const errorMsg = `Source charm "${sourceParsed.charmName}" not found. Available charms: ${
        charms.map((c) => c[NAME]).join(", ") || "none"
      }`;
      if (result) result.set(errorMsg);
      throw new Error(errorMsg);
    }

    // Find target charm
    const targetCharm = findCharmByName(charms, targetParsed.charmName);
    if (!targetCharm) {
      const errorMsg = `Target charm "${targetParsed.charmName}" not found. Available charms: ${
        charms.map((c) => c[NAME]).join(", ") || "none"
      }`;
      if (result) result.set(errorMsg);
      throw new Error(errorMsg);
    }

    // Build full paths including cell type if specified
    const sourceFullPath = sourceParsed.cellType
      ? [sourceParsed.cellType, ...sourceParsed.path]
      : sourceParsed.path;
    const targetFullPath = targetParsed.cellType
      ? [targetParsed.cellType, ...targetParsed.path]
      : targetParsed.path;

    // Navigate to cells
    const sourceCell = navigateToCell(sourceCharm, sourceFullPath);
    const targetCell = navigateToCell(targetCharm, targetFullPath);

    // Create write redirect link (alias)
    // This makes targetCell an alias of sourceCell:
    // - Reading targetCell shows sourceCell's value
    // - Writing to targetCell writes to sourceCell
    const link = sourceCell.getAsWriteRedirectLink();
    targetCell.set(link);

    const successMsg = `Successfully linked ${target} → ${source}`;
    if (result) result.set(successMsg);
    console.log(successMsg);
  } catch (error: unknown) {
    const errorMsg = error instanceof Error
      ? error.message
      : String(error);
    console.error("Link creation failed:", errorMsg);
    if (result) result.set(`Error: ${errorMsg}`);
    throw error;
  }
});

/**
 * Handler to list available charms
 */
const listCharms = handler<
  { result: Cell<string> },
  { charms: Array<any> }
>(({ result }, { charms }) => {
  const charmNames = charms.map((c) => c[NAME]).filter(Boolean);
  result.set(
    JSON.stringify({
      count: charmNames.length,
      charms: charmNames,
    }),
  );
});

type LinkToolInput = Record<string, never>;
type LinkToolOutput = {
  [NAME]: string;
  [UI]: any;
  createLink: any;
  listCharms: any;
};

export default recipe<LinkToolInput, LinkToolOutput>(
  "Link Tool",
  (_input) => {
    // Access all mentionable charms in the space
    const mentionable = wish<Array<any>>("#mentionable", []);
    const recentCharms = wish<Array<any>>("#recent", []);

    // Combine mentionable and recent charms, removing duplicates by NAME
    const allCharms = derive(
      [mentionable, recentCharms],
      ([m, r]: [Array<any>, Array<any>]) => {
        const combined = [...(m || []), ...(r || [])];
        const seen = new Set<string>();
        return combined.filter((c) => {
          const name = c[NAME];
          if (!name || seen.has(name)) return false;
          seen.add(name);
          return true;
        });
      },
    );

    const charmCount = derive(allCharms, (charms) => charms?.length || 0);

    return {
      [NAME]: "Link Tool",
      [UI]: (
        <div>
          <h3>Link Tool</h3>
          <p>Create links between charm cells</p>
          <p>Available charms: {charmCount}</p>
          <details>
            <summary>Usage</summary>
            <pre>
              {`{
  source: "SourceCharm/result/value",
  target: "TargetCharm/input/field"
}`}
            </pre>
          </details>
        </div>
      ),
      createLink: createLink({ charms: allCharms }),
      listCharms: listCharms({ charms: allCharms }),
    };
  },
);
