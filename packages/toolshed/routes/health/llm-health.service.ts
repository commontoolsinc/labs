import env from "@/env.ts";

// Discord webhook color constants
const DISCORD_COLORS = {
  GREEN: 3066993,
  RED: 15158332,
  YELLOW: 16776960,
} as const;

interface ModelTestResult {
  name: string;
  status: "healthy" | "failed";
  latencyMs: number | null;
  error?: string;
}

export interface ModelStatus {
  status: "healthy" | "failed";
  latencyMs: number | null;
  error?: string;
}

export interface LLMHealthCheckOptions {
  modelFilter?: string;
  isVerbose?: boolean;
  shouldAlert?: boolean;
  shouldForceAlert?: boolean;
}

export interface LLMHealthCheckResult {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  summary: {
    total: number;
    healthy: number;
    failed: number;
  };
  models: Record<string, ModelStatus>;
  alertSent: boolean;
}

/**
 * Fetch available LLM models from the API
 */
async function fetchAvailableModels(): Promise<string[]> {
  const modelsResponse = await fetch(
    `http://localhost:${env.PORT}/api/ai/llm/models`,
  );

  if (!modelsResponse.ok) {
    throw new Error("Failed to fetch available models");
  }

  const allModels = await modelsResponse.json();
  return Object.keys(allModels);
}

/**
 * Test a single LLM model
 */
async function testModel(
  modelName: string,
  isVerbose: boolean,
): Promise<ModelTestResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(`http://localhost:${env.PORT}/api/ai/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        system: "You are a health check bot. Respond with exactly one word.",
        messages: [{
          role: "user",
          content: "Say 'OK' to confirm you are working.",
        }],
        stream: false,
        cache: false,
      }),
      signal: AbortSignal.timeout(30000), // 30s timeout per model
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        name: modelName,
        status: "failed",
        latencyMs: null,
        error: isVerbose ? errorText : `HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    if (!data.content) {
      return {
        name: modelName,
        status: "failed",
        latencyMs: null,
        error: "No content in response",
      };
    }

    return {
      name: modelName,
      status: "healthy",
      latencyMs,
      error: undefined,
    };
  } catch (error) {
    return {
      name: modelName,
      status: "failed",
      latencyMs: null,
      error: isVerbose ? String(error) : "Request failed",
    };
  }
}

/**
 * Send Discord webhook alert for health check results
 */
async function sendDiscordAlert(
  failedCount: number,
  totalCount: number,
  healthyCount: number,
  overallStatus: string,
  failedModels: string[],
  modelStatuses: Record<string, ModelStatus>,
  shouldForceAlert: boolean,
  startTime: number,
): Promise<boolean> {
  const webhookUrl = env.LLM_HEALTH_DISCORD_WEBHOOK;

  if (!webhookUrl) {
    return false;
  }

  try {
    const environment = env.ENV || "development";
    const hostname = env.HOSTNAME || "localhost";

    // Determine alert severity
    const severity = shouldForceAlert && failedCount === 0
      ? "🟢 HEALTHY"
      : overallStatus === "unhealthy"
      ? "🔴 CRITICAL"
      : "🟡 WARNING";

    const color = shouldForceAlert && failedCount === 0
      ? DISCORD_COLORS.GREEN
      : overallStatus === "unhealthy"
      ? DISCORD_COLORS.RED
      : DISCORD_COLORS.YELLOW;

    // Calculate average latency for healthy models
    const healthyLatencies = Object.values(modelStatuses)
      .filter((m) => m.status === "healthy" && m.latencyMs)
      .map((m) => m.latencyMs as number);

    const avgLatency = healthyLatencies.length > 0
      ? Math.round(
        healthyLatencies.reduce((a, b) => a + b, 0) / healthyLatencies.length,
      )
      : 0;

    // Format failed models list (truncate if too long)
    let failedModelsList = failedModels.join(", ");
    if (failedModelsList.length > 1000) {
      failedModelsList = failedModelsList.substring(0, 997) + "...";
    }

    // Infrastructure-focused webhook message
    const webhookPayload = {
      content: null,
      embeds: [{
        title: `${severity} - LLM Service Health Alert`,
        description: shouldForceAlert && failedCount === 0
          ? `Test alert triggered manually - all systems operational`
          : `Automated health check detected ${failedCount} model failures`,
        color,
        fields: [
          {
            name: "📊 Status Overview",
            value:
              `• **Healthy**: ${healthyCount}/${totalCount}\n• **Failed**: ${failedCount}/${totalCount}\n• **Health Score**: ${
                Math.round((healthyCount / totalCount) * 100)
              }%`,
            inline: true,
          },
          {
            name: "🌍 Environment",
            value: `• **Env**: ${environment}\n• **Host**: ${hostname}`,
            inline: true,
          },
          {
            name: "⚡ Performance",
            value: `• **Avg Latency**: ${avgLatency}ms\n• **Check Duration**: ${
              Date.now() - startTime
            }ms`,
            inline: true,
          },
          {
            name: "❌ Failed Models",
            value: failedModelsList || "None",
            inline: false,
          },
        ],
        footer: {
          text: `LLM Health Monitor • ${new Date().toISOString()}`,
        },
        timestamp: new Date().toISOString(),
      }],
      username: "LLM Health Monitor",
      avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
    };

    // Send webhook directly
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(webhookPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[LLM Health Alert] Webhook failed:", {
        status: response.status,
        error: errorText,
        webhook: webhookUrl.substring(0, 50) + "...",
      });
      return false;
    }

    console.log(
      `[LLM Health Alert] Alert sent: ${severity} - ${failedCount} failures`,
    );
    return true;
  } catch (error) {
    // Silent failure - don't crash the health check
    console.error("[LLM Health Alert] Exception sending alert:", error);
    return false;
  }
}

/**
 * Perform health check on LLM models
 */
export async function checkLLMHealth(
  options: LLMHealthCheckOptions,
): Promise<LLMHealthCheckResult> {
  const startTime = Date.now();
  const {
    modelFilter,
    isVerbose = false,
    shouldAlert = false,
    shouldForceAlert = false,
  } = options;

  try {
    // Fetch available models
    let modelNames = await fetchAvailableModels();

    // Filter models if specified
    if (modelFilter) {
      const filters = modelFilter.split(",").map((s) => s.trim());
      modelNames = modelNames.filter((name) =>
        filters.some((filter) => name.includes(filter))
      );
    }

    // Test all models concurrently
    const testPromises = modelNames.map((modelName) =>
      testModel(modelName, isVerbose)
    );
    const results = await Promise.allSettled(testPromises);

    // Process results
    const modelStatuses: Record<string, ModelStatus> = {};
    let healthyCount = 0;
    let failedCount = 0;
    const failedModels: string[] = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        const modelResult = result.value;
        modelStatuses[modelResult.name] = {
          status: modelResult.status,
          latencyMs: modelResult.latencyMs,
          error: modelResult.error,
        };

        if (modelResult.status === "healthy") {
          healthyCount++;
        } else {
          failedCount++;
          failedModels.push(modelResult.name);
        }
      } else {
        // Promise rejected (shouldn't happen with our error handling)
        failedCount++;
      }
    }

    // Determine overall status
    const totalCount = modelNames.length;
    let overallStatus: "healthy" | "degraded" | "unhealthy";
    if (failedCount === 0) {
      overallStatus = "healthy";
    } else if (failedCount / totalCount > 0.5) {
      overallStatus = "unhealthy";
    } else {
      overallStatus = "degraded";
    }

    // Send infrastructure alert if needed (or forced)
    let alertSent = false;
    if ((shouldAlert && failedCount > 0) || shouldForceAlert) {
      alertSent = await sendDiscordAlert(
        failedCount,
        totalCount,
        healthyCount,
        overallStatus,
        failedModels,
        modelStatuses,
        shouldForceAlert,
        startTime,
      );
    }

    return {
      status: overallStatus,
      timestamp: Date.now(),
      summary: {
        total: totalCount,
        healthy: healthyCount,
        failed: failedCount,
      },
      models: modelStatuses,
      alertSent,
    };
  } catch (error) {
    // If we can't even fetch models, return unhealthy status
    return {
      status: "unhealthy",
      timestamp: Date.now(),
      summary: { total: 0, healthy: 0, failed: 0 },
      models: {},
      alertSent: false,
    };
  }
}
