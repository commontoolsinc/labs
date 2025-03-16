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
  private globalErrorHandlerInstalled = false;

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

    // Install global error handlers
    this.installGlobalErrorHandlers();
  }

  /**
   * Install global error handlers to catch unhandled errors
   * This prevents errors from crashing the service
   */
  private installGlobalErrorHandlers(): void {
    if (this.globalErrorHandlerInstalled) return;

    // Handle unhandled promise rejections
    self.addEventListener("unhandledrejection", (event) => {
      const errorMessage = event.reason instanceof Error
        ? event.reason.message
        : String(event.reason);
      
      // Print more error details if available
      if (event.reason instanceof Error && event.reason.stack) {
        log(`⚠️ Caught unhandled promise rejection: ${errorMessage}`);
        log(`Stack trace: ${event.reason.stack.split("\n").slice(0, 5).join("\n")}`);
      } else {
        log(`⚠️ Caught unhandled promise rejection: ${errorMessage}`);
        log(`Full rejection data: ${JSON.stringify(event.reason, null, 2)}`);
      }

      // Prevent the error from crashing the process
      event.preventDefault();
    });

    // Handle uncaught exceptions
    self.addEventListener("error", (event) => {
      log(`⚠️ Caught uncaught exception: ${event.message}`);
      log(`Location: ${event.filename}:${event.lineno}:${event.colno}`);

      // Prevent the error from crashing the process
      event.preventDefault();
    });

    this.globalErrorHandlerInstalled = true;
    log("Global error handlers installed");
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

    // Run immediately as a detached process, completely separate
    // from the timing mechanism - do NOT await this
    this.runDetachedCycle();

    // Set up a completely independent timer that runs regardless of
    // the cycles executing or failing
    this.setupIntervalTimer();

    // Set up a periodic check for charms that should be disabled
    this.setupDisableChecker();

    log(
      `Background Charm Service started with ${this.config.intervalSeconds}s interval`,
    );
  }

  /**
   * Set up a periodic checker that evaluates which charms should be disabled
   * This ensures that even if something goes wrong with the main execution flow,
   * problematic charms will eventually be disabled
   */
  private setupDisableChecker(): void {
    // Run this check every minute
    setInterval(() => {
      if (!this.running) return;

      // Get all charms from all cells
      Promise.all(this.config.integrationCells.map(async (cell) => {
        try {
          const charms = await cell.fetchCharms();

          // Check each charm's state
          for (const { space, charmId } of charms) {
            // Get the state for this charm
            const state = this.stateManager.getCharmState(
              space,
              charmId,
              cell.id,
            );

            // If enabled but has too many consecutive failures, disable it
            if (
              state.enabled &&
              state.consecutiveFailures >= this.config.maxConsecutiveFailures
            ) {
              log(
                `Disable checker: Disabling charm ${space}/${charmId} with ${state.consecutiveFailures} consecutive failures`,
              );
              this.stateManager.disableCharm(space, charmId);
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : String(error);
          log(`Error in disable checker for cell ${cell.id}: ${errorMessage}`);
        }
      })).catch((error) => {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        log(`Error in disable checker: ${errorMessage}`);
      });
    }, 60000); // Check every minute
  }

  /**
   * Run a cycle in a completely detached way
   * This ensures errors can't possibly affect the timing mechanism
   */
  private cycleRunning = false;
  private runDetachedCycle(): void {
    // Prevent multiple cycles from running at the same time
    if (this.cycleRunning) {
      log("Skipping cycle - previous cycle still running");
      return;
    }

    this.cycleRunning = true;
    
    Promise.resolve().then(() => {
      return this.runCycle();
    }).catch((error) => {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(`Error in detached cycle: ${errorMessage}`);
    }).finally(() => {
      // Make sure to set cycleRunning to false when done
      this.cycleRunning = false;
    });
  }

  /**
   * Set up a timer that runs independently of cycle execution
   * This is a bulletproof approach that ensures the timer always fires
   */
  private setupIntervalTimer(): void {
    // Use a true setInterval that runs independently of cycle execution
    this.intervalId = setInterval(() => {
      log(`Timer interval fired, launching new cycle`);

      // Run a new cycle completely detached from this timer
      this.runDetachedCycle();
    }, this.config.intervalSeconds * 1000) as unknown as number;
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
    const startTime = Date.now();

    try {
      // Process all cells with safety timeout
      await Promise.race([
        // Process cells with timeout protection
        this.processCellsWithTimeout(),

        // Global cycle timeout of 5 minutes
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Cycle timed out after 5 minutes")),
            300000,
          )
        ),
      ]);

      const duration = Date.now() - startTime;
      log(`Charm execution cycle completed in ${duration}ms`);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(`Cycle failed or timed out: ${errorMessage}`);
    }
  }

  /**
   * Process all cells with timeout protection
   */
  private processingCells = new Set<string>();
  private async processCellsWithTimeout(): Promise<void> {
    // Process all cells in series to avoid overwhelming the system
    for (const integrationCell of this.config.integrationCells) {
      // Skip cells that are already being processed
      if (this.processingCells.has(integrationCell.id)) {
        log(`Skipping cell ${integrationCell.id} - already being processed`);
        continue;
      }
      
      try {
        this.processingCells.add(integrationCell.id);
        log(`Processing cell ${integrationCell.id} with timeout protection`);

        // Add a timeout for each cell
        await Promise.race([
          this.processIntegrationCell(integrationCell),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`Cell ${integrationCell.id} processing timed out`),
                ),
              120000,
            )
          ),
        ]);
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        log(
          `Error or timeout processing cell ${integrationCell.id}: ${errorMessage}`,
        );

        // When a cell times out, we need to increment failure counts for all charms in the cell
        try {
          // Attempt to fetch charms one more time with a shorter timeout
          const fetchPromise = integrationCell.fetchCharms();
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Quick fetch timed out")), 10000)
          );
          
          const charms = await Promise.race([fetchPromise, timeoutPromise]) as {
            space: DID;
            charmId: string;
          }[];

          // Record a timeout failure for each charm in this cell
          for (const { space, charmId } of charms) {
            // Only update state for enabled charms
            if (this.stateManager.isCharmEnabled(space, charmId)) {
              log(
                `Recording timeout failure for charm ${space}/${charmId} due to cell timeout`,
              );

              // Create a timeout error with the cell timeout message
              const timeoutError = new Error(
                `Cell ${integrationCell.id} processing timed out`,
              );

              // Update the state with a failure
              this.stateManager.updateAfterExecution(
                space,
                charmId,
                integrationCell.id,
                {
                  success: false,
                  executionTimeMs: 0,
                  error: timeoutError,
                },
              );

              // Check if the charm should be disabled after this failure
              const state = this.stateManager.getCharmState(
                space,
                charmId,
                integrationCell.id,
              );
              if (
                state.consecutiveFailures >= this.config.maxConsecutiveFailures
              ) {
                log(
                  `Disabling charm ${space}/${charmId} after ${state.consecutiveFailures} consecutive failures`,
                );
                this.stateManager.disableCharm(space, charmId);
              }
            }
          }
        } catch (fetchError) {
          // If we can't even fetch the charms list, just log the error
          const fetchErrorMsg = fetchError instanceof Error
            ? fetchError.message
            : String(fetchError);
          log(
            `Could not fetch charms to update failure state: ${fetchErrorMsg}`,
          );
        }
      } finally {
        // Always remove the cell from processing set
        this.processingCells.delete(integrationCell.id);
      }
    }
  }

  /**
   * Process charms for a specific integration cell
   */
  private async processIntegrationCell(
    integrationCell: IntegrationCellConfig,
  ): Promise<void> {
    log(`Processing integration cell: ${integrationCell.name}`);

    try {
      // Fetch charms with a timeout
      const fetchStartTime = Date.now();
      log(`Fetching charms for integration: ${integrationCell.name}`);

      log(`Starting fetchCharms for integration: ${integrationCell.name}`);
      
      // Create an AbortController to abort the fetch if it times out
      const controller = new AbortController();
      const abortSignal = controller.signal;
      
      // Create a timeout that will abort the fetch (10 seconds should be plenty)
      const timeoutId = setTimeout(() => {
        log(`WARNING: fetchCharms for ${integrationCell.name} is taking too long (10 second timeout)`);
        controller.abort();
      }, 10000);
      
      try {
        // Race the fetch against a timeout with abort capability
        log(`Waiting for fetchCharms or timeout for: ${integrationCell.name}`);
        
        // Create the fetch as a promise that can be aborted
        const fetchWithAbort = new Promise<{space: DID; charmId: string}[]>((resolve, reject) => {
          // Start the fetch
          Promise.resolve().then(async () => {
            try {
              const result = await integrationCell.fetchCharms();
              if (!abortSignal.aborted) {
                resolve(result);
              }
            } catch (error) {
              if (!abortSignal.aborted) {
                reject(error);
              }
            }
          });
          
          // Listen for abort
          abortSignal.addEventListener('abort', () => {
            reject(new Error(`Fetching charms timed out after 30 seconds for ${integrationCell.name}`));
          });
        });
        
        // Wait for the fetch to complete or time out
        const charms = await fetchWithAbort;
        
        // Clear the timeout since we're done
        clearTimeout(timeoutId);
        
        log(`fetchCharms completed successfully for: ${integrationCell.name}`);
        log(`Fetched charms in ${Date.now() - fetchStartTime}ms`);
        
        if (charms.length === 0) {
          log(`No charms found for integration cell: ${integrationCell.name}`);
          return;
        }

        log(
          `Found ${charms.length} charms for integration: ${integrationCell.name}`,
        );
        log(`Charms: ${charms.map((c) => `${c.space}/${c.charmId}`).join(", ")}`);

        // Process each charm in sequence with individual timeouts
        for (const { space, charmId } of charms) {
          const charmKey = `${space}/${charmId}`;

          // Skip disabled charms
          if (!this.stateManager.isCharmEnabled(space, charmId)) {
            log(`Skipping disabled charm: ${charmKey}`);
            continue;
          }

          log(`Starting to process charm: ${charmKey}`);

          // Create an AbortController for this charm execution
          const charmController = new AbortController();
          const charmSignal = charmController.signal;
          const charmTimeoutId = setTimeout(() => {
            log(`WARNING: Processing charm ${charmKey} is taking too long (60 second timeout)`);
            charmController.abort();
          }, 60000);
          
          try {
            // Process the charm with abort capability
            await new Promise<void>((resolve, reject) => {
              // Start charm processing
              Promise.resolve().then(async () => {
                try {
                  await this.processCharm(space, charmId, integrationCell);
                  if (!charmSignal.aborted) {
                    resolve();
                  }
                } catch (error) {
                  if (!charmSignal.aborted) {
                    reject(error);
                  }
                }
              });
              
              // Listen for abort
              charmSignal.addEventListener('abort', () => {
                reject(new Error(`Processing charm ${charmKey} timed out after 60 seconds`));
              });
            });

            // Clear the charm timeout as we're done
            clearTimeout(charmTimeoutId);
            
            log(`Successfully processed charm: ${charmKey}`);
          } catch (error) {
            // Always clear the timeout
            clearTimeout(charmTimeoutId);
            
            const errorMessage = error instanceof Error
              ? error.message
              : String(error);
            log(`Error processing charm ${charmKey}: ${errorMessage}`);

            // Make sure to count this as a failure
            this.stateManager.updateAfterExecution(
              space,
              charmId,
              integrationCell.id,
              {
                success: false,
                executionTimeMs: 0,
                error: error instanceof Error ? error : new Error(String(error)),
              },
            );

            // Check if we should disable this charm
            const state = this.stateManager.getCharmState(
              space,
              charmId,
              integrationCell.id,
            );
            if (state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
              log(
                `Disabling charm ${charmKey} after ${state.consecutiveFailures} consecutive failures`,
              );
              this.stateManager.disableCharm(space, charmId);
            }
          }
        }

        log(`Completed processing all charms for ${integrationCell.name}`);
      } catch (innerError) {
        // Clear the timeout
        clearTimeout(timeoutId);
        
        const innerErrorMessage = innerError instanceof Error
          ? innerError.message
          : String(innerError);
        log(`Error during charm processing for ${integrationCell.name}: ${innerErrorMessage}`);
        throw innerError; // Re-throw for outer catch
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
   * Process a single charm - unified method with detailed logging
   */
  private processingCharms = new Set<string>();
  private async processCharm(
    space: DID,
    charmId: string,
    integrationCell: IntegrationCellConfig,
  ): Promise<void> {
    const startTime = Date.now();
    const charmKey = `${space}/${charmId}`;
    
    // Skip charms that are already being processed
    if (this.processingCharms.has(charmKey)) {
      log(`Skipping charm ${charmKey} - already being processed`);
      return;
    }
    
    this.processingCharms.add(charmKey);
    log(`Processing charm: ${charmKey}`);

    try {
      // STEP 1: Get manager for this space
      log(`Getting manager for space: ${space}`);
      const manager = await this.getManagerForSpace(space);
      log(`Manager loaded for space: ${space}`);

      // STEP 2: Load the charm
      log(`Loading charm: ${charmId}`);
      const charm = await manager.get(charmId, false);
      if (!charm) {
        const error = new Error(`Charm not found: id ${charmId}`);
        log(error.message);

        // Record failure
        this.stateManager.updateAfterExecution(
          space,
          charmId,
          integrationCell.id,
          {
            success: false,
            executionTimeMs: Date.now() - startTime,
            error,
          },
        );
        return;
      }
      log(`Charm loaded: ${charmId}`);

      // STEP 3: Get running charm and argument
      log(`Loading running charm and argument: ${charmId}`);
      const runningCharm = await manager.get(charm, true);
      const argument = manager.getArgument(charm);

      if (!runningCharm || !argument) {
        const error = new Error(`Charm not properly loaded: ${charmId}`);
        log(error.message);

        // Record failure
        this.stateManager.updateAfterExecution(
          space,
          charmId,
          integrationCell.id,
          {
            success: false,
            executionTimeMs: Date.now() - startTime,
            error,
          },
        );
        return;
      }
      log(`Running charm and argument loaded: ${charmId}`);

      // STEP 4: Validate that this charm belongs to this integration
      if (
        integrationCell.isValidIntegrationCharm &&
        !integrationCell.isValidIntegrationCharm(runningCharm)
      ) {
        const error = new Error(
          `Charm does not match integration type ${integrationCell.id}`,
        );
        log(error.message);

        // Record failure
        this.stateManager.updateAfterExecution(
          space,
          charmId,
          integrationCell.id,
          {
            success: false,
            executionTimeMs: Date.now() - startTime,
            error,
          },
        );
        return;
      }
      log(`Charm validation passed: ${charmId}`);

      // STEP 5: Execute the charm
      log(`Executing charm: ${charmId}`);
      const result = await this.executeCharm(runningCharm, argument, space);
      log(`Charm execution completed: ${charmId}, success=${result.success}`);

      // STEP 6: Update state
      log(`Updating state for charm: ${charmId}`);
      const state = this.stateManager.updateAfterExecution(
        space,
        charmId,
        integrationCell.id,
        result,
      );
      log(
        `State updated for charm: ${charmId}, consecutive failures: ${state.consecutiveFailures}`,
      );

      // STEP 7: Check if charm should be disabled
      if (
        !result.success &&
        state.consecutiveFailures >= this.config.maxConsecutiveFailures
      ) {
        log(
          `Disabling charm after ${state.consecutiveFailures} consecutive failures: ${charmId}`,
        );
        this.stateManager.disableCharm(space, charmId);
      }

      log(`Charm processing completed: ${charmId}`);
    } catch (error) {
      // Catch any unexpected errors
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(`Unexpected error processing charm ${charmKey}: ${errorMessage}`);

      // Record failure
      this.stateManager.updateAfterExecution(
        space,
        charmId,
        integrationCell.id,
        {
          success: false,
          executionTimeMs: Date.now() - startTime,
          error: error instanceof Error ? error : new Error(String(error)),
        },
      );

      // Check if this charm should be disabled
      const state = this.stateManager.getCharmState(
        space,
        charmId,
        integrationCell.id,
      );
      if (state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        log(
          `Disabling charm ${charmKey} after ${state.consecutiveFailures} consecutive failures`,
        );
        this.stateManager.disableCharm(space, charmId);
      }
    } finally {
      // Always remove the charm from the processing set
      this.processingCharms.delete(charmKey);
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

      // Execute the charm with better error handling
      const charmId = charm.entityId ? charm.entityId["/"] : "unknown";
      log(`Calling updater stream in charm: ${charmId}`);

      // Track if we've seen any unhandled rejections for this charm
      let sawUnhandledRejection = false;
      const errorHandler = (event: PromiseRejectionEvent | ErrorEvent) => {
        // Mark that we've seen an unhandled rejection for this charm
        sawUnhandledRejection = true;
        log(`Charm ${charmId} generated an unhandled error/rejection - marking for early completion`);
        
        // Don't prevent the default handler from also logging the error
        // event.preventDefault() is called by the global handler
      };

      // Install temporary error handlers specifically for this charm
      self.addEventListener("unhandledrejection", errorHandler);
      self.addEventListener("error", errorHandler);

      try {
        // Wrap the stream.send call in a try/catch to handle immediate errors
        log(`About to send message to stream for charm: ${charmId}`);
        
        // Use Promise.race with a timeout to prevent hanging on send
        await Promise.race([
          new Promise<void>((resolve) => {
            try {
              // Send the message and consider it successful immediately
              // Don't wait for the result since it may generate async errors
              updaterStream.send({});
              resolve();
            } catch (immediateError) {
              // Handle synchronous errors
              const errorMessage = immediateError instanceof Error
                ? immediateError.message
                : String(immediateError);
              log(`Immediate error in charm stream.send for ${charmId}: ${errorMessage}`);
              throw immediateError;
            }
          }),
          // Set a timeout to prevent hanging indefinitely (shorten to 15 seconds)
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error("Charm execution timed out after 15 seconds")), 15000)
          ),
          // Add a third promise that resolves early if we see an unhandled rejection
          new Promise<void>((resolve) => {
            const checkInterval = setInterval(() => {
              if (sawUnhandledRejection) {
                log(`Detected unhandled rejection in charm ${charmId}, ending execution early`);
                clearInterval(checkInterval);
                resolve();
              }
            }, 100); // Check every 100ms
            
            // Ensure we clean up this interval eventually
            setTimeout(() => clearInterval(checkInterval), 15000);
          })
        ]);
        
        log(`Stream message sent successfully for charm: ${charmId}`);

        // If we completed because of an unhandled rejection, return failure
        if (sawUnhandledRejection) {
          return {
            success: false,
            executionTimeMs: Date.now() - startTime,
            error: new Error("Charm generated unhandled promise rejection"),
          };
        }

        return {
          success: true,
          executionTimeMs: Date.now() - startTime,
          metadata: {
            tokenRefreshed: expiresAt && Date.now() > expiresAt,
          },
        };
      } catch (userCodeError) {
        // This handles synchronous errors from the user code
        const errorMessage = userCodeError instanceof Error
          ? userCodeError.message
          : String(userCodeError);

        log(`Error in charm user code for ${charmId}: ${errorMessage}`);

        if (userCodeError instanceof Error && userCodeError.stack) {
          log(
            `Error stack trace: ${
              userCodeError.stack.split("\n").slice(0, 5).join("\n")
            }`,
          );
        }

        return {
          success: false,
          executionTimeMs: Date.now() - startTime,
          error: userCodeError instanceof Error
            ? userCodeError
            : new Error(String(userCodeError)),
        };
      } finally {
        // Remove our temporary error handlers
        self.removeEventListener("unhandledrejection", errorHandler);
        self.removeEventListener("error", errorHandler);
      }
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
        // Log which stream we found to help debugging
        log(`Found stream '${name}' in charm ${charm.entityId ? charm.entityId["/"] : "unknown"}`);
        return stream;
      }
    }

    // If no stream found, log all available keys in the charm
    const charmId = charm.entityId ? charm.entityId["/"] : "unknown";
    try {
      const keys = Object.keys(charm.toJSON());
      log(`No updater stream found in charm ${charmId}. Available keys: ${keys.join(", ")}`);
    } catch (error) {
      log(`No updater stream found in charm ${charmId} and could not enumerate keys`);
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
