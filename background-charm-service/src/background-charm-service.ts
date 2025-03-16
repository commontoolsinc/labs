import {
  Cell,
  getEntityId,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { Charm, CharmManager } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import * as Session from "./session.ts";
import {
  CharmExecutionResult,
  CharmServiceConfig,
  CharmState,
  IntegrationCellConfig,
} from "./types.ts";
import { StateManager } from "./state-manager.ts";
import { log, parseCharmsInput } from "./utils.ts";

/**
 * Main background charm service class
 * Manages the lifecycle of charm execution across multiple integration cells
 */
export class BackgroundCharmService {
  private stateManager: StateManager;
  private intervalId?: number;
  private running = false;
  private managerCache = new Map<string, CharmManager>();

  constructor(private config: CharmServiceConfig) {
    this.stateManager = new StateManager(config.logIntervalSeconds);

    log("Background Charm Service initialized with configuration:");
    log(`- Interval: ${config.intervalSeconds} seconds`);
    log(`- Max consecutive failures: ${config.maxConsecutiveFailures}`);
    log(
      `- Integration cells: ${
        config.integrationCells.map((i) => i.name).join(", ")
      }`,
    );
  }

  /**
   * Start the background charm service
   */
  async start(): Promise<void> {
    if (this.running) {
      log("Background Charm Service is already running");
      return;
    }

    this.running = true;
    log("Starting Background Charm Service");

    // Run immediately
    await this.runCycle();

    // Set up interval
    this.intervalId = setInterval(() => {
      this.runCycle().catch((error) => {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        log(`Error in run cycle: ${errorMessage}`);
      });
    }, this.config.intervalSeconds * 1000) as unknown as number;

    log(
      `Background Charm Service started with ${this.config.intervalSeconds}s interval`,
    );
  }

  /**
   * Stop the background charm service
   */
  stop(): void {
    if (!this.running) {
      log("Background Charm Service is not running");
      return;
    }

    this.running = false;
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    log("Background Charm Service stopped");
    this.stateManager.logStates();
  }

  /**
   * Run a single execution cycle for all integration cells
   */
  private async runCycle(): Promise<void> {
    log("Starting charm execution cycle");

    for (const integrationCell of this.config.integrationCells) {
      try {
        await this.processIntegrationCell(integrationCell);
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        log(
          `Error processing integration cell ${integrationCell.id}: ${errorMessage}`,
        );
      }
    }

    log("Charm execution cycle completed");
  }

  /**
   * Process charms for a specific integration cell
   */
  private async processIntegrationCell(
    integrationCell: IntegrationCellConfig,
  ): Promise<void> {
    log(`Processing integration cell: ${integrationCell.name}`);

    try {
      // Fetch charms for this integration cell
      const charms = await integrationCell.fetchCharms();
      if (charms.length === 0) {
        log(
          `No charms found for integration cell: ${integrationCell.name}`,
        );
        return;
      }

      log(
        `Found ${charms.length} charms for integration: ${integrationCell.name}`,
      );

      // Process each charm
      for (const { space, charmId } of charms) {
        // Skip disabled charms
        if (!this.stateManager.isCharmEnabled(space, charmId)) {
          log(`Skipping disabled charm: ${space}/${charmId}`);
          continue;
        }

        try {
          await this.processCharm(space, charmId, integrationCell);
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : String(error);
          log(
            `Error processing charm ${space}/${charmId}: ${errorMessage}`,
          );
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(
        `Error fetching charms for integration ${integrationCell.name}: ${errorMessage}`,
      );
    }
  }

  /**
   * Process a single charm
   */
  private async processCharm(
    space: DID,
    charmId: string,
    integrationCell: IntegrationCellConfig,
  ): Promise<void> {
    log(`Processing charm: ${space}/${charmId}`);

    // Get or create manager for this space
    const manager = await this.getManagerForSpace(space);

    // Get the charm
    const charm = await manager.get(charmId, false);
    if (!charm) {
      log(`Charm not found: id ${charmId}`);
      return;
    }

    // Get running charm and argument
    const runningCharm = await manager.get(charm, true);
    const argument = manager.getArgument(charm);

    if (!runningCharm || !argument) {
      log("Charm not properly loaded", { charm });
      return;
    }

    // Validate that this charm belongs to this integration
    if (
      integrationCell.isValidIntegrationCharm &&
      !integrationCell.isValidIntegrationCharm(runningCharm)
    ) {
      log(`Charm does not match integration type ${integrationCell.id}`, {
        charm,
      });
      return;
    }

    // Execute the charm
    const result = await this.executeCharm(runningCharm, argument, space);

    // Update state
    const state = this.stateManager.updateAfterExecution(
      space,
      charmId,
      integrationCell.id,
      result,
    );

    // Check if charm should be disabled based on failure policy
    if (
      !result.success &&
      state.consecutiveFailures >= this.config.maxConsecutiveFailures
    ) {
      log(
        `Disabling charm after ${state.consecutiveFailures} consecutive failures`,
        { charm },
      );
      this.stateManager.disableCharm(space, charmId);
    }
  }

  /**
   * Execute a charm and track execution time
   */
  private async executeCharm(
    charm: Cell<Charm>,
    argument: Cell<any>,
    space: DID,
  ): Promise<CharmExecutionResult> {
    const startTime = Date.now();

    try {
      const auth = argument.key("auth");
      const updaterStream = this.findUpdaterStream(charm);

      if (!updaterStream || !auth) {
        return {
          success: false,
          executionTimeMs: Date.now() - startTime,
          error: new Error("Invalid charm: missing updater stream or auth"),
        };
      }

      const { token, expiresAt } = auth.get();

      // Refresh token if needed
      if (token && expiresAt && Date.now() > expiresAt) {
        log("Token expired, refreshing", { charm });

        try {
          await this.refreshAuthToken(auth, charm, space);
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : String(error);
          log(`Error refreshing token: ${errorMessage}`, { charm });

          return {
            success: false,
            executionTimeMs: Date.now() - startTime,
            error: new Error(`Token refresh failed: ${errorMessage}`),
          };
        }
      } else if (!token) {
        return {
          success: false,
          executionTimeMs: Date.now() - startTime,
          error: new Error("Missing authentication token"),
        };
      }

      // Execute the charm
      log(`Calling updater stream in charm`, { charm });
      updaterStream.send({});

      return {
        success: true,
        executionTimeMs: Date.now() - startTime,
        metadata: {
          tokenRefreshed: expiresAt && Date.now() > expiresAt,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(`Error executing charm: ${errorMessage}`, { charm });

      return {
        success: false,
        executionTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Find the updater stream in a charm
   * This supports various integration types by looking for common stream names
   */
  private findUpdaterStream(charm: Cell<Charm>): Cell<any> | null {
    // Check for known updater streams
    const streamNames = [
      "updater",
      "googleUpdater",
      "githubUpdater",
      "notionUpdater",
      "calendarUpdater",
    ];

    for (const name of streamNames) {
      const stream = charm.key(name);
      if (isStream(stream)) {
        return stream;
      }
    }

    return null;
  }

  /**
   * Refresh an authentication token
   */
  private async refreshAuthToken(
    auth: Cell<any>,
    charm: Cell<Charm>,
    space: DID,
  ): Promise<void> {
    const authCellId = JSON.parse(JSON.stringify(auth.getAsCellLink()));
    authCellId.space = space as string;
    log(`Token expired, refreshing: ${authCellId}`, { charm });

    // Determine the integration type for token refresh
    const integrationTypes = ["google", "github", "notion", "calendar"];
    let integrationType = "google"; // Default

    // Try to determine integration type from charm keys
    for (const type of integrationTypes) {
      if (
        charm.key(`${type}Updater`) && isStream(charm.key(`${type}Updater`))
      ) {
        integrationType = type;
        break;
      }
    }

    // Get the toolshed URL from environment
    const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
      "https://toolshed.saga-castor.ts.net/";

    const refresh_url = new URL(
      `/api/integrations/${integrationType}-oauth/refresh`,
      toolshedUrl,
    );

    const refresh_response = await fetch(refresh_url, {
      method: "POST",
      body: JSON.stringify({ authCellId }),
    });

    const refresh_data = await refresh_response.json();
    if (!refresh_data.success) {
      throw new Error(
        `Error refreshing token: ${JSON.stringify(refresh_data)}`,
      );
    }

    await storage.synced();
    log("Token refreshed successfully", { charm });
  }

  /**
   * Get or create a charm manager for a space
   */
  private async getManagerForSpace(space: DID): Promise<CharmManager> {
    const spaceKey = space.toString();

    if (this.managerCache.has(spaceKey)) {
      return this.managerCache.get(spaceKey)!;
    }

    // Get operator password from environment
    const operatorPass = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

    // Create a new session and manager
    const session = await Session.open({
      passphrase: operatorPass,
      name: "~background-service",
      space,
    });

    const manager = new CharmManager(session);
    this.managerCache.set(spaceKey, manager);

    return manager;
  }
}
