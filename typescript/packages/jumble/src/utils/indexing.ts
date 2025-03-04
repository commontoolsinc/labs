import { CharmManager, getRecipeFrom } from "@commontools/charm";
import { BackgroundJob } from "@/contexts/BackgroundTaskContext.tsx";
import { charmId } from "./charms.ts";
import { llm } from "./llm.ts";
import { Cell, getCellFromDocLink } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { getIframeRecipe } from "../../../common-charm/src/iframe/recipe.ts";
import { UI } from "../../../common-builder/src/types.ts";
interface IndexingContext {
  startJob: (name: string) => string;
  stopJob: (jobId: string) => void;
  addJobMessage: (jobId: string, message: string) => void;
  updateJobProgress: (jobId: string, progress: number) => void;
  listJobs: () => BackgroundJob[];
}

const CONCURRENT_LIMIT = 3;
function saveToMemory(
  space: string,
  entity: string,
  data: any,
  contentType: string = "application/json",
): Promise<Response> {
  return fetch("/api/storage/memory", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      [space]: {
        assert: {
          the: contentType,
          of: entity,
          is: data,
        },
      },
    }),
  });
}

async function annotateCharmWithDescription(
  charm: Cell<Charm>,
  jobId: string,
  context: IndexingContext,
  replica: string,
): Promise<void> {
  try {
    // Simulate indexing work for this example
    context.addJobMessage(jobId, `Indexing charm ${charmId(charm)}...`);
    console.log("indexing", charm);
    const stringified = JSON.stringify(charm.asSchema({}).get());

    const response = await llm.sendRequest({
      model: "anthropic:claude-3-7-sonnet-latest",
      messages: [
        {
          role: "user",
          content:
            `Analyze this UI component JSON and describe it in a single terse paragraph with up to 2 relevant hashtags: ${stringified}`,
        },
      ],
    });
    context.addJobMessage(jobId, response);
    console.log(stringified, response);

    await saveToMemory(
      replica,
      charmId(charm)!,
      response,
      "text/plain;variant=description",
    );

    await new Promise((resolve) => setTimeout(resolve, 200)); // Simulate work
    context.addJobMessage(jobId, `✓ Indexed charm ${charmId(charm)}`);
  } catch (error) {
    context.addJobMessage(
      jobId,
      `Failed to index charm ${charm.entityId}: ${error}`,
    );
    console.error(error);
  }
}

function extractSvgFromResponse(response: string): string {
  // Regular expression to match SVG content
  const svgRegex = /<svg[\s\S]*?<\/svg>/i;
  const match = response.match(svgRegex);

  if (match && match[0]) {
    return match[0];
  }

  // Check for code block with SVG
  const codeBlockRegex = /```(?:html|svg)?\s*((?:<svg[\s\S]*?<\/svg>))```/i;
  const codeMatch = response.match(codeBlockRegex);

  if (codeMatch && codeMatch[1]) {
    return codeMatch[1];
  }

  // Return original response if no SVG found
  return response;
}

async function annotateCharmWithPreviewImage(
  charm: Cell<Charm>,
  jobId: string,
  context: IndexingContext,
  replica: string,
): Promise<void> {
  try {
    // Simulate indexing work for this example
    context.addJobMessage(jobId, `Indexing charm ${charmId(charm)}...`);
    console.log("indexing", charm);
    const stringified = JSON.stringify(charm.asSchema({}).get());

    let src: string | undefined = "";
    try {
      const { iframe, recipeId } = await getIframeRecipe(charm);
      if (iframe === undefined) {
        throw new Error("iframe is undefined");
      }
      src = iframe.src;
    } catch (error) {
      console.error(error);
      const recipe = await getRecipeFrom(charm);
      src = recipe?.src;
    }
    const data = {
      argument: charm.getSourceCell()?.["argument"] ?? {},
      UI: charm.get()[UI],
    };

    const response = await llm.sendRequest({
      model: "anthropic:claude-3-7-sonnet-latest",
      messages: [
        {
          role: "user",
          content: `analyse this source code then extract an SVG "preview" of it

            the preview should split into 3 layers, 'fg', 'main' and 'bg' (use exact IDs) which will parallax in 3D in the final render

            we want to get the spirit of the charm, don't adhere to closely to the literal markup, be creative.

            ${src}

            this sourcecode will be rendered using this data:

            ${JSON.stringify(data)}`,
        },
      ],
    });
    context.addJobMessage(jobId, response);
    console.log(stringified, response);

    const link = charm.getAsDocLink();
    link.path = ["$PREVIEW"];
    const preview = getCellFromDocLink({ uri: replica }, link);
    preview.set(extractSvgFromResponse(response));

    context.addJobMessage(jobId, `✓ Indexed charm ${charmId(charm)}`);
  } catch (error) {
    context.addJobMessage(
      jobId,
      `Failed to index charm ${charm.entityId}: ${error}`,
    );
    console.error(error);
  }
}

export async function startCharmIndexing(
  charmManager: CharmManager,
  context: IndexingContext,
): Promise<void> {
  const jobId = context.startJob("Indexing Charms");
  context.addJobMessage(jobId, "Starting charm indexing...");

  try {
    const charms = charmManager.getCharms().get();
    const total = charms.length;

    if (total === 0) {
      context.addJobMessage(jobId, "No charms found to index");
      context.stopJob(jobId);
      return;
    }

    context.addJobMessage(jobId, `Found ${total} charms to index`);
    let completed = 0;

    // Process charms in batches of CONCURRENT_LIMIT
    for (let i = 0; i < total; i += CONCURRENT_LIMIT) {
      const batch = charms.slice(i, i + CONCURRENT_LIMIT);

      // Check if job was stopped
      const job = context.listJobs().find((j) => j.id === jobId);
      if (!job || job.status !== "running") {
        context.addJobMessage(jobId, "Indexing stopped by user");
        return;
      }

      await Promise.all(
        batch.map((charm) =>
          annotateCharmWithPreviewImage(
            charm,
            jobId,
            context,
            charmManager.getReplica()!,
          )
        ),
      );

      completed += batch.length;
      const progress = completed / total;
      context.updateJobProgress(jobId, progress);
      context.addJobMessage(
        jobId,
        `Progress: ${completed}/${total} charms (${
          Math.round(progress * 100)
        }%)`,
      );
    }

    context.addJobMessage(jobId, "Indexing completed successfully");
  } catch (error) {
    context.addJobMessage(jobId, `Indexing failed with error: ${error}`);
    console.error(error);
  } finally {
    context.stopJob(jobId);
  }
}
