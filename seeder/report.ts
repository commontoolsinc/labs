import type { CharmResult, ExecutedScenario, Scenario } from "./interfaces.ts";
import { dirname, fromFileUrl, join } from "@std/path";

// FIXME(ja): we should just use handlebars or something...  claude built a custom template engine for this...
// it works, and claude really doesn't want to change... at some point this will be a pain and we should fix it

// Get the directory of the current module
const __dirname = dirname(fromFileUrl(import.meta.url));

export const ensureReportDir = async (name: string) => {
  const reportDir = `results/${name}`;
  try {
    const stat = await Deno.stat(reportDir);
    if (!stat.isDirectory) {
      await Deno.mkdir(reportDir, { recursive: true });
    }
  } catch {
    await Deno.mkdir(reportDir, { recursive: true });
  }
};

// Helper function to group results by scenario
function groupResultsByScenario(
  results: CharmResult[],
  scenarios: Scenario[],
): Map<number, { name: string; results: CharmResult[] }> {
  const groups = new Map<number, { name: string; results: CharmResult[] }>();
  let currentScenario = 0;

  // Initialize the first scenario group
  groups.set(currentScenario, {
    name: scenarios[currentScenario]?.name || `Scenario ${currentScenario + 1}`,
    results: [],
  });

  // Process each result
  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    // Check if we need to move to the next scenario
    // We do this by checking if we've processed all steps in the current scenario
    let stepsInCurrentScenario = 0;
    for (let j = 0; j <= currentScenario; j++) {
      if (j < scenarios.length) {
        stepsInCurrentScenario += scenarios[j].steps.length;
      }
    }

    // If we've processed all steps in the current scenario, move to the next one
    if (i >= stepsInCurrentScenario && currentScenario < scenarios.length - 1) {
      currentScenario++;
      groups.set(currentScenario, {
        name: scenarios[currentScenario]?.name ||
          `Scenario ${currentScenario + 1}`,
        results: [],
      });
    }

    // Add the result to the current scenario group
    groups.get(currentScenario)!.results.push(result);
  }

  return groups;
}

// Helper function to load and replace placeholders in a template
async function loadTemplate(templateName: string): Promise<string> {
  const templatePath = join(__dirname, "templates", templateName);
  try {
    return await Deno.readTextFile(templatePath);
  } catch (error) {
    console.error(`Error loading template ${templatePath}:`, error);
    throw error;
  }
}

// Helper function to replace placeholders in a template
function replaceTemplatePlaceholders(
  template: string,
  replacements: Record<string, string | number>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(
      new RegExp(`{{${key}}}`, "g"),
      String(value),
    );
  }
  return result;
}

export async function generateReport(
  name: string,
  executedScenarios: ExecutedScenario[],
  toolshedUrl: string,
  allScenarios: Scenario[],
) {
  // Calculate overall statistics
  const totalScenarios = executedScenarios.length;

  // Flatten all results to calculate overall statistics
  const allResults: CharmResult[] = executedScenarios.flatMap((es) =>
    es.results
  );
  const totalSteps = allResults.length;
  const totalPassed = allResults.filter((r) => r.status === "PASS").length;
  const totalFailed = totalSteps - totalPassed;
  const passRate = totalSteps > 0
    ? Math.round((totalPassed / totalSteps) * 100)
    : 0;

  // Load templates
  const reportTemplate = await loadTemplate("report-template.html");
  const scenarioTemplate = await loadTemplate("scenario-template.html");
  const resultTemplate = await loadTemplate("result-template.html");

  // Generate scenarios HTML
  const scenariosHtml = await Promise.all(
    executedScenarios.map(async (executedScenario, groupIndex) => {
      const scenarioData = executedScenario.results;
      const scenarioName = executedScenario.scenario.name ||
        `Scenario ${groupIndex + 1}`;

      const scenarioPassed = scenarioData.filter((r) =>
        r.status === "PASS"
      ).length;
      const scenarioFailed = scenarioData.length - scenarioPassed;
      const scenarioPassRate = scenarioData.length > 0
        ? Math.round((scenarioPassed / scenarioData.length) * 100)
        : 0;
      const headerBgColor = scenarioPassRate >= 80
        ? "bg-blue-600"
        : scenarioPassRate >= 50
        ? "bg-yellow-500"
        : "bg-red-600";

      // Generate results HTML for this scenario
      const resultsHtml = await Promise.all(
        scenarioData.map((result, index) => {
          const statusColor = result.status === "PASS"
            ? "bg-green-100 text-green-800"
            : "bg-red-100 text-red-800";

          const relativePath = result.screenshotPath?.replace(
            `results/`,
            "./",
          );

          const screenshotHtml = result.screenshotPath
            ? `<a href="${relativePath}" target="_blank"><img src="${relativePath}" alt="Screenshot" class="w-full h-48 object-cover"></a>`
            : `<div class="w-full h-48 bg-gray-100 flex items-center justify-center"><p class="text-gray-500">No screenshot available</p></div>`;

          return replaceTemplatePlaceholders(resultTemplate, {
            RESULT_DELAY: (groupIndex * 0.1) + (index * 0.05),
            SCREENSHOT_HTML: screenshotHtml,
            STATUS_COLOR: statusColor,
            STATUS: result.status,
            TOOLSHED_URL: toolshedUrl,
            NAME: name,
            RESULT_ID: result.id,
            SHORT_ID: result.id.slice(-6),
            PROMPT: result.prompt,
            SUMMARY: result.summary,
          });
        }),
      );

      return replaceTemplatePlaceholders(scenarioTemplate, {
        SCENARIO_INDEX: groupIndex * 0.1,
        HEADER_BG_COLOR: headerBgColor,
        SCENARIO_NAME: scenarioName,
        SCENARIO_PASSED: scenarioPassed,
        SCENARIO_FAILED: scenarioFailed,
        SCENARIO_PASS_RATE: scenarioPassRate,
        SCENARIO_RESULTS: resultsHtml.join(""),
      });
    }),
  );

  // Create the final HTML with the main template
  const formattedDate = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const html = replaceTemplatePlaceholders(reportTemplate, {
    NAME: name,
    DATE: formattedDate,
    TOTAL_SCENARIOS: totalScenarios,
    TOTAL_STEPS: totalSteps,
    TOTAL_PASSED: totalPassed,
    TOTAL_FAILED: totalFailed,
    PASS_RATE: passRate,
    SCENARIOS_HTML: scenariosHtml.join(""),
  });

  const reportPath = `results/${name}.html`;
  await Deno.writeTextFile(reportPath, html);
  console.log(`Report generated: ${reportPath}`);
}
