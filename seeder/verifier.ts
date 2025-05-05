import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { Browser } from "./browser.ts";
import { CharmResult } from "./interfaces.ts";
import { sleep } from "@commontools/utils/sleep";

const model = openai("gpt-4o-mini");

export class Verifier {
  private browser: Browser;

  constructor({ browser }: { browser: Browser }) {
    this.browser = browser;
  }

  static async initialize(
    { headless, apiUrl }: { headless: boolean; apiUrl: string },
  ) {
    const browser = await Browser.launch({
      headless,
      apiUrl,
    });
    return new Verifier({ browser });
  }

  async verify(
    { id, prompt, name }: { id: string; prompt: string; name: string },
  ): Promise<CharmResult> {
    // FIXME(ja): can we navigate without causing a page reload?
    await this.browser.goto(`/${name!}/${id}`);
    // FIXME(ja): perhaps charm can emit a "ready" event and we can wait for it?
    await sleep(10000);
    const screenshotPath = `results/${name}/${id}.png`;
    await this.browser.screenshot(screenshotPath);
    const errors = await this.browser.checkForErrors();
    if (errors.length > 0) {
      return {
        id,
        prompt,
        screenshotPath,
        status: "FAIL",
        summary: `Errors: ${errors.join("\n")}`,
      };
    }

    const verdict = await llmVerifyCharm(prompt, screenshotPath);
    console.log(`Charm verified: ${id} - ${verdict}`);

    const parsedVerdict = JSON.parse(verdict);
    return {
      id,
      prompt,
      screenshotPath,
      status: parsedVerdict.result,
      summary: parsedVerdict.summary,
    };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

async function llmVerifyCharm(
  prompt: string,
  filename: string,
): Promise<string> {
  // Lazily load so we don't need an API key when not verifying
  const { generateObject } = await import("ai");

  const system = `You are a helpful assistant that verifies charm screenshots.
  
  Your task is to evaluate how well the screenshot represents what the user asked for in the prompt.
  
  If the screenshot accurately represents the prompt, return a PASS result with a brief explanation.
  If the screenshot does not match the prompt, return a FAIL result with a brief explanation of what's missing or incorrect.`;

  const schema = z.object({
    result: z.enum(["PASS", "FAIL"]),
    summary: z.string().describe("A 1-sentence summary of your evaluation"),
  });

  const { object } = await generateObject({
    system: system,
    model,
    schema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          { type: "image", image: Deno.readFileSync(filename) },
        ],
      },
    ],
  });

  const result = schema.parse(object);
  console.log({ result });
  return JSON.stringify(result);
}
