import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  BackgroundIntegrationRoute,
  CallbackRoute,
  CreateLinkTokenRoute,
  ExchangeTokenRoute,
  RefreshAccountsRoute,
  RemoveItemRoute,
  SyncTransactionsRoute,
} from "./plaid-oauth.routes.ts";
import {
  type CallbackResult,
  createBackgroundIntegrationErrorResponse,
  createBackgroundIntegrationSuccessResponse,
  createCallbackResponse,
  createExchangeErrorResponse,
  createExchangeSuccessResponse,
  createLinkTokenErrorResponse,
  createLinkTokenSuccessResponse,
  createPlaidClient,
  createRefreshErrorResponse,
  createRefreshSuccessResponse,
  createRemoveErrorResponse,
  createRemoveSuccessResponse,
  createSyncErrorResponse,
  createSyncSuccessResponse,
  getAuthData,
  getBaseUrl,
  getPlaidItem,
  type PlaidItem,
  removePlaidItem,
  upsertPlaidItem,
} from "./plaid-oauth.utils.ts";
import { setBGCharm } from "@commontools/background-charm";
import { type CellLink } from "@commontools/runner";
import { runtime } from "@/index.ts";
import env from "@/env.ts";
import { CountryCode } from "plaid";

/**
 * Plaid Create Link Token Handler
 * Creates a Link token for initiating Plaid Link
 */
export const createLinkToken: AppRouteHandler<CreateLinkTokenRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info({ payload }, "Received Plaid create link token request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return createLinkTokenErrorResponse(c, "Missing authCellId in request");
    }

    const plaidClient = createPlaidClient();

    // Create a user ID for Plaid (can be any stable string)
    const userId = "commontools-user";

    // Use the redirect URI from env (backend callback URL)
    // This should match what's configured in Plaid dashboard
    const redirectUri = env.PLAID_REDIRECT_URI || payload.redirectUri;

    // Create link token request
    const linkTokenRequest: any = {
      user: {
        client_user_id: userId,
      },
      client_name: "Common Tools",
      products: payload.products || ["transactions"],
      country_codes: (payload.countryCodes || ["US"]) as CountryCode[],
      language: "en",
    };
    
    // Only add redirect_uri if provided
    if (redirectUri) {
      linkTokenRequest.redirect_uri = redirectUri;
    }

    logger.debug({ linkTokenRequest }, "Creating Plaid link token");
    console.log("Create plaid link token request", linkTokenRequest);

    const response = await plaidClient.linkTokenCreate(linkTokenRequest);
    console.log("Create plaid link token response", response);
    const { link_token, expiration } = response.data;

    logger.info(
      { linkToken: link_token.substring(0, 20) + "...", expiration },
      "Created Plaid link token",
    );

    // Create the hosted Link URL
    // Use the standard hosted Link URL without deprecated isWebview parameter
    const hostedLinkUrl =
      `https://cdn.plaid.com/link/v2/stable/link.html?token=${link_token}`;

    return c.json({
      linkToken: link_token,
      hostedLinkUrl,
      expiration,
    });
  } catch (error: any) {
    logger.error({ error }, "Failed to create link token");
    
    // Extract Plaid error details if available
    if (error.response?.data) {
      logger.error({ plaidError: error.response.data }, "Plaid API error details");
      const plaidError = error.response.data;
      return c.json({
        error: plaidError.error_message || "Failed to create link token",
        error_code: plaidError.error_code,
        error_type: plaidError.error_type,
        display_message: plaidError.display_message,
      }, 400);
    }
    
    return createLinkTokenErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to create link token",
    );
  }
};

/**
 * Plaid Exchange Token Handler
 * Exchanges a public token for an access token and stores account data
 */
export const exchangeToken: AppRouteHandler<ExchangeTokenRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info(
      { publicToken: payload.publicToken.substring(0, 20) + "..." },
      "Received Plaid token exchange request",
    );

    if (!payload.publicToken || !payload.authCellId) {
      logger.error("Missing required fields in request payload");
      return createExchangeErrorResponse(
        c,
        "Missing publicToken or authCellId in request",
      );
    }

    const plaidClient = createPlaidClient();

    // Exchange public token for access token
    logger.debug("Exchanging public token for access token");
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: payload.publicToken,
    });

    const { access_token, item_id } = exchangeResponse.data;

    logger.info(
      {
        accessTokenPrefix: access_token.substring(0, 21) + "...",
        itemId: item_id,
      },
      "Exchanged public token for access token",
    );

    // Fetch account details
    logger.debug("Fetching account details");
    const accountsResponse = await plaidClient.accountsGet({
      access_token,
    });

    const { accounts, item } = accountsResponse.data;

    // Get institution details (use metadata if provided, otherwise fetch)
    let institutionId = payload.metadata?.institution?.institutionId;
    let institutionName = payload.metadata?.institution?.name;

    if (!institutionId && item.institution_id) {
      try {
        const institutionResponse = await plaidClient.institutionsGetById({
          institution_id: item.institution_id,
          country_codes: ["US"] as CountryCode[],
        });
        institutionId = institutionResponse.data.institution.institution_id;
        institutionName = institutionResponse.data.institution.name;
      } catch (error) {
        logger.warn(
          { error },
          "Failed to fetch institution details, using defaults",
        );
        institutionId = item.institution_id || "unknown";
        institutionName = "Unknown Institution";
      }
    }

    // Prepare item data for storage
    const plaidItem: PlaidItem = {
      accessToken: access_token,
      itemId: item_id,
      institutionId: institutionId || "unknown",
      institutionName: institutionName || "Unknown Institution",
      accounts: accounts.map((account) => ({
        accountId: account.account_id,
        name: account.name,
        mask: account.mask || "",
        type: account.type,
        subtype: account.subtype || "",
        balances: {
          available: account.balances.available,
          current: account.balances.current,
          limit: account.balances.limit,
          isoCurrencyCode: account.balances.iso_currency_code,
          unofficialCurrencyCode: account.balances.unofficial_currency_code,
        },
      })),
      products: item.available_products || ["accounts", "transactions"],
      consentExpirationTime: item.consent_expiration_time || null,
      lastUpdated: new Date().toISOString(),
      lastSyncCursor: null,
    };

    // Save to auth cell
    await upsertPlaidItem(payload.authCellId, plaidItem);

    // Add this charm to the Plaid integration charms cell
    try {
      const authCellLink = JSON.parse(payload.authCellId) as CellLink;
      const space = authCellLink.space;
      const integrationCharmId = payload.integrationCharmId;

      if (space && integrationCharmId) {
        logger.info(
          { space, integrationCharmId },
          "Adding Plaid integration charm",
        );

        await setBGCharm({
          space,
          charmId: integrationCharmId,
          integration: "plaid",
          runtime,
        });
      }
    } catch (error) {
      logger.warn(
        { error },
        "Failed to add charm to Plaid integrations, continuing anyway",
      );
    }

    return createExchangeSuccessResponse(c, item_id);
  } catch (error) {
    logger.error({ error }, "Failed to exchange token");
    return createExchangeErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to exchange token",
    );
  }
};

/**
 * Plaid Refresh Accounts Handler
 * Refreshes account balances and metadata
 */
export const refreshAccounts: AppRouteHandler<RefreshAccountsRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info({ payload }, "Received Plaid refresh accounts request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return createRefreshErrorResponse(c, "Missing authCellId in request");
    }

    const plaidClient = createPlaidClient();
    const authData = await getAuthData(payload.authCellId);
    let updatedItems = 0;

    // Filter items to refresh
    const itemsToRefresh = payload.itemId
      ? authData.items.filter((item) => item.itemId === payload.itemId)
      : authData.items;

    if (itemsToRefresh.length === 0) {
      logger.warn("No items found to refresh");
      return createRefreshSuccessResponse(c, 0);
    }

    // Refresh each item
    for (const item of itemsToRefresh) {
      try {
        logger.debug({ itemId: item.itemId }, "Refreshing accounts for item");

        const accountsResponse = await plaidClient.accountsGet({
          access_token: item.accessToken,
        });

        const { accounts } = accountsResponse.data;

        // Update item with fresh account data
        const updatedItem: PlaidItem = {
          accessToken: item.accessToken,
          itemId: item.itemId,
          institutionId: item.institutionId,
          institutionName: item.institutionName,
          accounts: accounts.map((account) => ({
            accountId: account.account_id,
            name: account.name,
            mask: account.mask || "",
            type: account.type,
            subtype: account.subtype || "",
            balances: {
              available: account.balances.available,
              current: account.balances.current,
              limit: account.balances.limit,
              isoCurrencyCode: account.balances.iso_currency_code,
              unofficialCurrencyCode: account.balances.unofficial_currency_code,
            },
          })),
          products: item.products,
          consentExpirationTime: item.consentExpirationTime,
          lastUpdated: new Date().toISOString(),
          lastSyncCursor: item.lastSyncCursor,
        };

        await upsertPlaidItem(payload.authCellId, updatedItem);
        updatedItems++;

        logger.info(
          { itemId: item.itemId, accountCount: accounts.length },
          "Successfully refreshed accounts",
        );
      } catch (error) {
        logger.error(
          { error, itemId: item.itemId },
          "Failed to refresh accounts for item",
        );
        // Continue with other items even if one fails
      }
    }

    return createRefreshSuccessResponse(c, updatedItems);
  } catch (error) {
    logger.error({ error }, "Failed to refresh accounts");
    return createRefreshErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to refresh accounts",
    );
  }
};

/**
 * Plaid Sync Transactions Handler
 * Syncs transactions using the /transactions/sync endpoint
 */
export const syncTransactions: AppRouteHandler<SyncTransactionsRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info({ payload }, "Received Plaid sync transactions request");

    if (!payload.authCellId) {
      logger.error("Missing authCellId in request payload");
      return createSyncErrorResponse(c, "Missing authCellId in request");
    }

    const plaidClient = createPlaidClient();
    const authData = await getAuthData(payload.authCellId);
    let totalAdded = 0;
    let totalModified = 0;
    let totalRemoved = 0;
    let hasMoreOverall = false;

    // Filter items to sync
    const itemsToSync = payload.itemId
      ? authData.items.filter((item) => item.itemId === payload.itemId)
      : authData.items;

    if (itemsToSync.length === 0) {
      logger.warn("No items found to sync");
      return createSyncSuccessResponse(c, 0, 0, 0, false);
    }

    // Sync transactions for each item
    for (const item of itemsToSync) {
      try {
        logger.debug({ itemId: item.itemId }, "Syncing transactions for item");

        let hasMore = true;
        let cursor = item.lastSyncCursor;
        let itemAdded = 0;
        let itemModified = 0;
        let itemRemoved = 0;

        // Continue syncing until no more updates
        while (hasMore) {
          const syncRequest: any = {
            access_token: item.accessToken,
            count: payload.count || 500,
          };

          if (cursor) {
            syncRequest.cursor = cursor;
          }

          const syncResponse = await plaidClient.transactionsSync(syncRequest);
          const {
            added,
            modified,
            removed,
            next_cursor,
            has_more,
          } = syncResponse.data;

          itemAdded += added.length;
          itemModified += modified.length;
          itemRemoved += removed.length;
          cursor = next_cursor;
          hasMore = has_more;

          logger.debug(
            {
              itemId: item.itemId,
              added: added.length,
              modified: modified.length,
              removed: removed.length,
              hasMore,
            },
            "Synced transaction batch",
          );

          // Break after one batch if we're not syncing everything
          if (!env.PLAID_SYNC_ALL_TRANSACTIONS) {
            break;
          }
        }

        // Update the item's sync cursor
        const updatedItem: PlaidItem = {
          accessToken: item.accessToken,
          itemId: item.itemId,
          institutionId: item.institutionId,
          institutionName: item.institutionName,
          accounts: item.accounts as PlaidItem["accounts"],
          products: item.products,
          consentExpirationTime: item.consentExpirationTime,
          lastSyncCursor: cursor,
          lastUpdated: new Date().toISOString(),
        };

        await upsertPlaidItem(payload.authCellId, updatedItem);

        totalAdded += itemAdded;
        totalModified += itemModified;
        totalRemoved += itemRemoved;
        if (hasMore) hasMoreOverall = true;

        logger.info(
          {
            itemId: item.itemId,
            added: itemAdded,
            modified: itemModified,
            removed: itemRemoved,
          },
          "Successfully synced transactions",
        );
      } catch (error) {
        logger.error(
          { error, itemId: item.itemId },
          "Failed to sync transactions for item",
        );
        // Continue with other items even if one fails
      }
    }

    return createSyncSuccessResponse(
      c,
      totalAdded,
      totalModified,
      totalRemoved,
      hasMoreOverall,
    );
  } catch (error) {
    logger.error({ error }, "Failed to sync transactions");
    return createSyncErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to sync transactions",
    );
  }
};

/**
 * Plaid Remove Item Handler
 * Removes a connected bank account
 */
export const removeItem: AppRouteHandler<RemoveItemRoute> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();
    logger.info({ payload }, "Received Plaid remove item request");

    if (!payload.authCellId || !payload.itemId) {
      logger.error("Missing required fields in request payload");
      return createRemoveErrorResponse(
        c,
        "Missing authCellId or itemId in request",
      );
    }

    const plaidClient = createPlaidClient();

    // Get the item to remove
    const item = await getPlaidItem(payload.authCellId, payload.itemId);
    if (!item) {
      logger.warn({ itemId: payload.itemId }, "Item not found");
      return createRemoveErrorResponse(c, "Item not found");
    }

    // Remove from Plaid
    try {
      await plaidClient.itemRemove({
        access_token: item.accessToken,
      });
      logger.info({ itemId: payload.itemId }, "Removed item from Plaid");
    } catch (error) {
      logger.error(
        { error, itemId: payload.itemId },
        "Failed to remove item from Plaid, continuing with local removal",
      );
    }

    // Remove from auth cell
    await removePlaidItem(payload.authCellId, payload.itemId);

    logger.info(
      { itemId: payload.itemId },
      "Successfully removed item from auth cell",
    );

    return createRemoveSuccessResponse(c);
  } catch (error) {
    logger.error({ error }, "Failed to remove item");
    return createRemoveErrorResponse(
      c,
      error instanceof Error ? error.message : "Failed to remove item",
    );
  }
};

/**
 * Plaid OAuth Callback Handler
 * Handles OAuth callbacks from Plaid hosted Link
 */
export const callback: AppRouteHandler<CallbackRoute> = async (c) => {
  const logger = c.get("logger");
  const query = c.req.query();

  logger.info({ query }, "Received Plaid OAuth callback");

  try {
    const { 
      public_token, 
      oauth_state_id,
      error: linkError, 
      error_code, 
      error_message,
      state 
    } = query;

    // Determine the frontend URL to redirect to
    const frontendBaseUrl = state || "http://localhost:5173";
    
    // Handle OAuth flow - if we have oauth_state_id, this is an OAuth institution
    if (oauth_state_id && !public_token && !linkError) {
      logger.info(
        { oauth_state_id },
        "OAuth flow detected - user needs to complete OAuth at institution",
      );
      
      // For OAuth institutions, Plaid first redirects here, then user must complete
      // OAuth at their bank, then they come back through Link again
      // We should show a message that they need to continue in Plaid Link
      const continueUrl = new URL(frontendBaseUrl);
      continueUrl.searchParams.set("oauth_continue", "true");
      continueUrl.searchParams.set("oauth_state_id", oauth_state_id);
      return c.redirect(continueUrl.toString());
    }

    // Handle Link errors
    if (linkError || error_code) {
      logger.error(
        { linkError, error_code, error_message },
        "Link error received",
      );

      const errorUrl = new URL(frontendBaseUrl);
      errorUrl.searchParams.set(
        "error",
        linkError || error_code || "unknown_error",
      );
      if (error_message) {
        errorUrl.searchParams.set("error_message", error_message);
      }
      return c.redirect(errorUrl.toString());
    }

    // Handle successful link with public token
    if (public_token) {
      logger.info(
        { publicToken: public_token.substring(0, 20) + "..." },
        "Received public token",
      );

      const successUrl = new URL(frontendBaseUrl);
      successUrl.searchParams.set("public_token", public_token);
      return c.redirect(successUrl.toString());
    }

    // No token or error - something went wrong
    logger.error("No public token or error in callback");
    const errorUrl = new URL(frontendBaseUrl);
    errorUrl.searchParams.set("error", "invalid_callback");
    return c.redirect(errorUrl.toString());
  } catch (error) {
    logger.error(error, "Failed to process callback");

    // Try to redirect with error
    try {
      const errorUrl = new URL(query.redirect_uri || "/");
      errorUrl.searchParams.set("error", "callback_processing_error");
      return c.redirect(errorUrl.toString());
    } catch {
      // If we can't redirect, return an error page
      const callbackResult: CallbackResult = {
        success: false,
        error: "Failed to process callback",
      };
      return createCallbackResponse(callbackResult);
    }
  }
};

/**
 * Background Integration Handler
 * Sets up background sync for Plaid
 */
export const backgroundIntegration: AppRouteHandler<
  BackgroundIntegrationRoute
> = async (c) => {
  const logger = c.get("logger");

  try {
    const payload = await c.req.json();

    await setBGCharm({
      space: payload.space,
      charmId: payload.charmId,
      integration: payload.integration,
      runtime,
    });

    return createBackgroundIntegrationSuccessResponse(c, "success");
  } catch (error) {
    logger.error({ error }, "Failed to process background integration request");
    return createBackgroundIntegrationErrorResponse(
      c,
      "Failed to process background integration request",
    );
  }
};
