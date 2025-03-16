import { Integration } from "../types.ts";
import { log } from "../utils.ts";

// Integration registry
const integrations = new Map<string, Integration>();

/**
 * Dynamically load all integration modules
 */
export async function loadIntegrations(): Promise<void> {
  try {
    // Get the directory containing the integrations
    const dirUrl = new URL(".", import.meta.url);

    // List all files in the directory
    for await (const entry of Deno.readDir(dirUrl)) {
      // Skip non-TypeScript files and this index file
      if (
        !entry.isFile || !entry.name.endsWith(".ts") ||
        entry.name === "index.ts"
      ) {
        continue;
      }

      try {
        // Get the integration ID from the filename (without .ts extension)
        const integrationId = entry.name.replace(/\.ts$/, "");

        // Skip already loaded integrations
        if (integrations.has(integrationId)) {
          continue;
        }

        // Try to import the integration module
        const module = await import(`./${entry.name}`);

        // Check if the default export is an Integration
        if (
          module.default && typeof module.default === "object" &&
          "id" in module.default
        ) {
          const integration = module.default as Integration;

          // Register the integration
          registerIntegration(integration);
          log(
            `Registered integration: ${integration.name} (${integration.id})`,
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error loading integration ${entry.name}: ${errorMessage}`);
      }
    }

    log(`Loaded ${integrations.size} integrations`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Error scanning integrations directory: ${errorMessage}`);
  }
}

/**
 * Get all available integrations
 */
export function getAvailableIntegrations(): Integration[] {
  return Array.from(integrations.values());
}

/**
 * Get available integration IDs
 */
export function getAvailableIntegrationIds(): string[] {
  return Array.from(integrations.keys());
}

/**
 * Get an integration by ID
 */
export function getIntegration(id: string): Integration | undefined {
  return integrations.get(id);
}

/**
 * Register a new integration
 */
export function registerIntegration(integration: Integration): void {
  integrations.set(integration.id, integration);
}

// Load integrations on module import
await loadIntegrations();
