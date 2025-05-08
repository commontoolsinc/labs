import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { CharmResult } from "./interfaces.ts";
import { sleep } from "@commontools/utils/sleep";
import { Browser, Page, pipeConsole } from "@commontools/integration";
import { login } from "@commontools/integration/jumble";

const model = openai("gpt-4o-mini");

export class Verifier {
  private browser: Browser;
  private page: Page;
  private apiUrl: string;

  private constructor(
    { browser, page, apiUrl }: { browser: Browser; page: Page; apiUrl: string },
  ) {
    this.browser = browser;
    this.page = page;
    this.apiUrl = apiUrl;

    page.addEventListener("console", pipeConsole);
  }

  static async initialize(
    { headless, apiUrl }: { headless: boolean; apiUrl: string },
  ) {
    const browser = await Browser.launch({
      headless,
      args: ["--window-size=1280,1024"],
    });
    try {
      const page = await browser.newPage();
      return new Verifier({ browser, page, apiUrl });
    } catch (e) {
      await browser.close();
      throw e;
    }
  }

  async verify(
    { id, prompt, name }: { id: string; prompt: string; name: string },
  ): Promise<CharmResult> {
    // FIXME(ja): can we navigate without causing a page reload?
    await this.page.goto(`${this.apiUrl}/${name!}/${id}`);
    await this.page.applyConsoleFormatter();
    await sleep(1000);
    await addErrorListeners(this.page);
    await login(this.page);

    // FIXME(ja): perhaps charm can emit a "ready" event and we can wait for it?
    await sleep(10000);
    const screenshotPath = `results/${name}/${id}.png`;
    await this.page.screenshot(screenshotPath);
    const errors = await checkPageForErrors(this.page);
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

async function checkPageForErrors(page: Page): Promise<any> {
  return await page.evaluate(() => {
    // @ts-ignore: this code is stringified and sent to browser context
    return globalThis.charmRuntimeErrors;
  });
}

async function addErrorListeners(page: Page): Promise<any> {
  return await page.evaluate(() => {
    // @ts-ignore: this code is stringified and sent to browser context
    globalThis.charmRuntimeErrors = [];
    globalThis.addEventListener("common-iframe-error", (e) => {
      // @ts-ignore: this code is stringified and sent to browser context
      globalThis.charmRuntimeErrors.push(e.detail.description);
    });
  });
}
