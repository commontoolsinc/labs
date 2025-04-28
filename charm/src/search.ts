import {
  Charm,
  charmId,
  CharmManager,
  DEFAULT_MODEL,
} from "@commontools/charm";
import { NAME, Recipe, recipe } from "@commontools/builder";
import { LLMClient } from "@commontools/llm";
import { Cell, recipeManager } from "@commontools/runner";

export type CharmSearchResult = {
  charm: Cell<Charm>;
  name: string;
  reason: string;
};

export async function searchCharms(
  input: string,
  charmManager: CharmManager,
): Promise<{
  charms: CharmSearchResult[];
  thinking: string;
}> {
  try {
    const charms = charmManager.getCharms();
    await charmManager.sync(charms);
    const results = await Promise.all(
      charms.get().map(async (charm) => {
        const data = charm.get();
        const title = data?.[NAME] ?? "Untitled";

        const recipeId = await charmManager.syncRecipe(charm);
        const recipe = recipeManager.recipeById(recipeId!)!;

        return {
          title: title + ` (#${charmId(charm.entityId!)!.slice(-4)})`,
          description: (recipe as Recipe).argumentSchema.description,
          id: charmId(charm.entityId!)!,
          value: charm.entityId!,
        };
      }),
    );

    // Early return if no charms are found
    if (!results.length) {
      return {
        thinking: "No charms are available to search through.",
        charms: [],
      };
    }

    const response = await new LLMClient().sendRequest({
      system:
        `Pick up to the 3 most appropriate (if any) charms from the list that match the user's request:
      <charms>
        ${
          results.map((result) =>
            `<charm id="${result.id}">
          <title>${result.title}</title>
          <description>${result.description}</description>
        </charm>`
          ).join("\n          ")
        }
      </charms>

      When responding, you may include a terse paragraph of your reasoning within a <thinking> tag, then return a list of charms using <charm id="" name="...">Reason it's appropriate</charm> in the text.`,
      messages: [{ role: "user", content: input }],
      model: DEFAULT_MODEL,
      cache: false,
      metadata: {
        context: "workflow",
        workflow: "search-charms",
        generationId: crypto.randomUUID(),
      },
    });

    // Parse the thinking tag content
    const thinkingMatch = response.content?.match(
      /<thinking>([\s\S]*?)<\/thinking>/,
    );
    const thinking = thinkingMatch ? thinkingMatch[1].trim() : "";

    // Parse all charm tags
    const charmMatches = response.content?.matchAll(
      /<charm id="([^"]+)" name="([^"]+)">([\s\S]*?)<\/charm>/g,
    );

    const selectedCharms = [];
    if (charmMatches) {
      for (const match of charmMatches) {
        const charmId = match[1];
        const charmName = match[2];
        const reason = match[3].trim();

        // Find the original charm data from results
        const originalCharm = await charmManager.get(charmId);

        if (originalCharm) {
          selectedCharms.push({
            charm: originalCharm,
            name: charmName,
            reason,
          });
        }
      }
    }

    return {
      thinking,
      charms: selectedCharms,
    };
  } catch (error) {
    console.error("Search charms error:", error);

    return {
      thinking: "An error occurred while searching for charms.",
      charms: [],
    };
  }
}
