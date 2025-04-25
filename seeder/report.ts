import type { CharmResult, ExecutedScenario, Scenario } from "./interfaces.ts";

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

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${name} - ${
    new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })
  }</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      .fade-in {
        animation: fadeIn 0.5s ease-in-out;
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .hover-scale {
        transition: transform 0.3s ease;
      }
      .hover-scale:hover {
        transform: scale(1.03);
      }
    </style>
  </head>
  <body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto px-4 py-8">
      <h1 class="text-3xl font-bold text-center text-gray-800 mb-4">${name}</h1>
  
      <!-- Summary Section -->
      <div class="mb-8 fade-in bg-white p-5 rounded-lg shadow-md">
        <h2 class="text-xl font-semibold mb-3 border-b pb-2">Summary</h2>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 text-center">
          <div class="bg-blue-50 p-3 rounded-lg">
            <p class="text-blue-800 font-bold text-2xl">${totalScenarios}</p>
            <p class="text-blue-600">Scenarios</p>
          </div>
          <div class="bg-gray-50 p-3 rounded-lg">
            <p class="text-gray-800 font-bold text-2xl">${totalSteps}</p>
            <p class="text-gray-600">Total Steps</p>
          </div>
          <div class="bg-green-50 p-3 rounded-lg">
            <p class="text-green-800 font-bold text-2xl">${totalPassed}</p>
            <p class="text-green-600">Passed</p>
          </div>
          <div class="bg-red-50 p-3 rounded-lg">
            <p class="text-red-800 font-bold text-2xl">${totalFailed}</p>
            <p class="text-red-600">Failed</p>
          </div>
        </div>
        <div class="mt-4 w-full bg-gray-200 rounded-full h-4">
          <div class="bg-green-500 h-4 rounded-full" style="width: ${passRate}%"></div>
        </div>
        <p class="text-center mt-1 text-gray-600">${passRate}% Success Rate</p>
      </div>
  
      ${
    executedScenarios.map(
      (executedScenario, groupIndex) => {
        const scenarioData = executedScenario.results;
        const scenarioName = executedScenario.scenario.name ||
          `Scenario ${groupIndex + 1}`;

        const scenarioPassed =
          scenarioData.filter((r) => r.status === "PASS").length;
        const scenarioFailed = scenarioData.length - scenarioPassed;
        const scenarioPassRate = scenarioData.length > 0
          ? Math.round((scenarioPassed / scenarioData.length) * 100)
          : 0;
        const headerBgColor = scenarioPassRate >= 80
          ? "bg-blue-600"
          : scenarioPassRate >= 50
          ? "bg-yellow-500"
          : "bg-red-600";

        return `
          <div class="mb-10 fade-in" style="animation-delay: ${
          groupIndex * 0.1
        }s">
            <div class="${headerBgColor} text-white py-3 px-5 rounded-t-lg shadow-md flex justify-between items-center">
              <h2 class="text-xl font-semibold">${scenarioName}</h2>
              <div class="flex items-center space-x-2">
                <span class="bg-white text-green-700 px-2 py-1 rounded-md text-sm">${scenarioPassed} ✓</span>
                <span class="bg-white text-red-700 px-2 py-1 rounded-md text-sm">${scenarioFailed} ✗</span>
                <span class="bg-white text-gray-700 px-2 py-1 rounded-md text-sm">${scenarioPassRate}%</span>
              </div>
            </div>
            <div class="bg-white p-5 rounded-b-lg shadow-md">
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                ${
          scenarioData.map((result, index) => {
            const statusColor = result.status === "PASS"
              ? "bg-green-100 text-green-800"
              : "bg-red-100 text-red-800";

            const relativePath = result.screenshotPath?.replace(
              `results/`,
              "./",
            );

            return `
                      <div class="bg-white rounded-lg overflow-hidden shadow-md hover-scale fade-in" style="animation-delay: ${
              (groupIndex * 0.1) + (index * 0.05)
            }s">
                        <div class="relative">
                          ${
              result.screenshotPath
                ? `
                            <a href="${relativePath}" target="_blank">
                              <img src="${relativePath}" alt="Screenshot" class="w-full h-48 object-cover">
                            </a>
                          `
                : `
                            <div class="w-full h-48 bg-gray-100 flex items-center justify-center">
                              <p class="text-gray-500">No screenshot available</p>
                            </div>
                          `
            }
                          <div class="absolute top-0 right-0 m-2">
                            <span class="px-3 py-1 rounded-full text-sm font-medium ${statusColor}">
                              ${result.status}
                            </span>
                          </div>
                        </div>
                        <div class="p-4">
                          <a href="${toolshedUrl}/${name}/${result.id}" class="text-blue-600 hover:text-blue-800 font-medium" target="_blank">
                            Charm ID: ${result.id.slice(-6)}
                          </a>
                          <p class="mt-2 text-gray-700 font-medium">Prompt:</p>
                          <p class="text-gray-600 mb-3">${result.prompt}</p>
                          <p class="text-gray-700 font-medium">Verdict:</p>
                          <p class="text-gray-600">${result.summary}</p>
                        </div>
                      </div>
                    `;
          }).join("")
        }
              </div>
            </div>
          </div>
        `;
      },
    ).join("")
  }
    </div>
  </body>
  </html>
    `;

  const reportPath = `results/${name}.html`;
  await Deno.writeTextFile(reportPath, html);
  console.log(`Report generated: ${reportPath}`);
}
