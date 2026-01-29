import { DEFAULT_MODEL, pieceId, PieceManager } from "@commontools/piece";
import { nameSchema } from "@commontools/runner/schemas";
import { Cell, NAME } from "@commontools/runner";
import { extractTextFromLLMResponse, LLMClient } from "@commontools/llm";
import { isObject } from "@commontools/utils/types";

export type PieceSearchResult = {
  piece: Cell<unknown>;
  name: string;
  reason: string;
};

export async function searchPieces(
  input: string,
  pieceManager: PieceManager,
): Promise<{
  pieces: PieceSearchResult[];
  thinking: string;
}> {
  try {
    const piecesCell = await pieceManager.getPieces();
    await pieceManager.sync(piecesCell);
    const results = await Promise.all(
      piecesCell.get().map(async (piece: Cell<unknown>) => {
        try {
          const data = piece.asSchema(nameSchema).get();
          const title = data?.[NAME] ?? "Untitled";

          const recipe = await pieceManager.syncRecipe(piece);

          return {
            title: title + ` (#${pieceId(piece)!.slice(-4)})`,
            description: isObject(recipe.argumentSchema)
              ? recipe.argumentSchema.description
              : undefined,
            id: pieceId(piece)!,
            value: piece.entityId!,
          };
        } catch (error) {
          console.error(`Error processing piece:`, error);
          // Return a minimal viable object to keep the array intact
          return {
            title: "Error loading piece",
            description: "Failed to load piece details",
            id: piece.entityId ? pieceId(piece)! : "unknown",
            value: piece.entityId || "unknown",
          };
        }
      }),
    );

    // Early return if no pieces are found
    if (!results.length) {
      console.warn("No pieces are available to search through.");
      return {
        thinking: "No pieces are available to search through.",
        pieces: [],
      };
    }

    const response = await new LLMClient().sendRequest({
      system:
        `Pick up to the 3 most appropriate (if any) pieces from the list that match the user's request:
      <pieces>
        ${
          results.map((result) =>
            `<piece id="${result.id}">
          <title>${result.title}</title>
          <description>${result.description}</description>
        </piece>`
          ).join("\n          ")
        }
      </pieces>

      When responding, you may include a terse paragraph of your reasoning within a <thinking> tag, then return a list of pieces using <piece id="" name="...">Reason it's appropriate</piece> in the text.`,
      messages: [{ role: "user", content: input }],
      model: DEFAULT_MODEL,
      cache: false,
      metadata: {
        context: "workflow",
        workflow: "search-pieces",
        generationId: crypto.randomUUID(),
      },
    });

    // Parse the thinking tag content
    const thinkingMatch = extractTextFromLLMResponse(response).match(
      /<thinking>([\s\S]*?)<\/thinking>/,
    );
    const thinking = thinkingMatch ? thinkingMatch[1].trim() : "";

    // Parse all piece tags
    const pieceMatches = extractTextFromLLMResponse(response).matchAll(
      /<piece id="([^"]+)" name="([^"]+)">([\s\S]*?)<\/piece>/g,
    );

    const selectedPieces: {
      piece: Cell<unknown>;
      name: string;
      reason: string;
    }[] = [];
    if (pieceMatches) {
      for (const match of pieceMatches) {
        const pieceId = match[1];
        const pieceName = match[2];
        const reason = match[3].trim();

        // Find the original piece data from results
        const originalPiece = await pieceManager.get(pieceId);

        if (originalPiece) {
          selectedPieces.push({
            piece: originalPiece,
            name: pieceName,
            reason,
          });
        }
      }
    }

    return {
      thinking,
      pieces: selectedPieces,
    };
  } catch (error: unknown) {
    console.error(
      "Search pieces error:",
      (isObject(error) && "message" in error)
        ? error.message
        : JSON.stringify(error),
    );

    return {
      thinking: "An error occurred while searching for pieces.",
      pieces: [],
    };
  }
}
