import { Integration } from "../types.ts";
import { log } from "../utils.ts";
import gmailIntegration from "./gmail.ts";
import discordIntegration from "./discord.ts";

// Integration registry
const integrations = new Map<string, Integration>();

/**
 * Load all integrations explicitly (typechecking!)
 */
export function loadIntegrations(): void {
  try {
    // Register integrations explicitly
    registerIntegration(gmailIntegration);
    registerIntegration(discordIntegration);

    log(`Loaded ${integrations.size} integrations`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Error loading integrations: ${errorMessage}`);
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
loadIntegrations();
