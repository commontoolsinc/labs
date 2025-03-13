import { CharmManager } from "@commontools/charm";
import { BackgroundJob } from "@/contexts/BackgroundTaskContext.tsx";
import { charmId } from "./charms.ts";
import { client as llm } from "@commontools/llm";
import { Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";
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

async function indexCharm(
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
          indexCharm(charm, jobId, context, charmManager.getSpace())
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
