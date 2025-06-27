# Plaid OAuth Integration Implementation Plan

## Overview

This document outlines the comprehensive plan for implementing Plaid OAuth
integration, modeled after the existing Google OAuth implementation but adapted
for Plaid's specific requirements.

## Key Differences from Google OAuth

1. **Token Flow**: Plaid uses Link tokens → Public tokens → Access tokens (not
   traditional OAuth2)
2. **No Refresh Tokens**: Plaid access tokens don't expire like OAuth2 tokens
3. **Product-Based Scopes**: Instead of OAuth scopes, Plaid uses "products"
   (transactions, accounts, etc.)
4. **Institution-Specific**: Each connected bank account is a separate "Item"
   with its own access token

## Architecture Overview

### Backend Components

```
/packages/toolshed/routes/integrations/plaid-oauth/
├── plaid-oauth.index.ts      # Router setup with CORS
├── plaid-oauth.routes.ts     # Route definitions
├── plaid-oauth.handlers.ts   # Request handlers
└── plaid-oauth.utils.ts      # Helper functions
```

### Frontend Components

```
/packages/ui/src/v1/components/
└── common-plaid-oauth.ts     # Web component for Plaid Link
```

### Recipe Integration

```
/recipes/
└── plaid.tsx                 # Single recipe for accounts and transactions
```

## Implementation Steps

### Phase 1: Backend Infrastructure

#### 1.1 Environment Configuration

Add to environment variables:

```
PLAID_CLIENT_ID=xxx
PLAID_SECRET=xxx
PLAID_ENV=sandbox|development|production
PLAID_PRODUCTS=transactions,accounts,identity
PLAID_COUNTRY_CODES=US,CA,GB
PLAID_REDIRECT_URI=https://app.domain.com/api/integrations/plaid-oauth/callback
```

#### 1.2 Route Definitions (`plaid-oauth.routes.ts`)

- **POST `/api/integrations/plaid-oauth/create-link-token`**
  - Creates a Plaid Link token for initiating OAuth
  - Input: `authCellId`, `integrationCharmId`, `userId`, `products[]`
  - Output: `linkToken`, `expiration`

- **GET `/api/integrations/plaid-oauth/callback`**
  - Handles OAuth redirect from financial institution
  - Query params: `public_token`, `state`, `error`
  - Exchanges public token for access token

- **POST `/api/integrations/plaid-oauth/exchange-token`**
  - Exchanges public token for access token
  - Input: `publicToken`, `authCellId`
  - Output: Success status with stored credentials

- **POST `/api/integrations/plaid-oauth/refresh-accounts`**
  - Refreshes account/transaction data
  - Input: `authCellId`
  - Output: Updated account data

- **POST `/api/integrations/plaid-oauth/remove-item`**
  - Removes a connected bank account
  - Input: `authCellId`, `itemId`
  - Output: Success status

#### 1.3 Handlers Implementation (`plaid-oauth.handlers.ts`)

**Create Link Token Handler**:

```typescript
- Initialize Plaid client
- Generate Link token with:
  - client_user_id (derived from authCellId)
  - products array
  - country_codes
  - redirect_uri
  - webhook URL (optional)
- Return link_token and expiration
```

**Callback Handler**:

```typescript
- Validate state parameter
- Handle error cases
- Exchange public_token for access_token via Plaid API
- Fetch account details
- Store in auth cell:
  - access_token
  - item_id
  - institution details
  - accounts array
- Return success HTML with postMessage
```

**Token Exchange Handler**:

```typescript
- Receive public_token from frontend
- Exchange for access_token
- Fetch and store account metadata
- Set up webhook for updates (optional)
```

#### 1.4 Utils Implementation (`plaid-oauth.utils.ts`)

**PlaidClient Helper**:

```typescript
- Create configured Plaid client instance
- Handle different environments (sandbox/development/production)
```

**Auth Schema for Plaid**:

```typescript
const PlaidAuthSchema = {
  type: "object",
  properties: {
    // Support multiple bank connections (Items)
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          accessToken: {
            type: "string",
            ifc: { classification: ["secret"] },
          },
          itemId: { type: "string" },
          institutionId: { type: "string" },
          institutionName: { type: "string" },
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                accountId: { type: "string" },
                name: { type: "string" },
                mask: { type: "string" },
                type: { type: "string" },
                subtype: { type: "string" },
                balances: {
                  type: "object",
                  properties: {
                    available: { type: "number" },
                    current: { type: "number" },
                    limit: { type: "number" },
                  },
                },
              },
            },
          },
          products: { type: "array", items: { type: "string" } },
          consentExpirationTime: { type: "string" },
          lastUpdated: { type: "string" },
        },
      },
      default: [],
    },
  },
} as const satisfies JSONSchema;
```

### Phase 2: Frontend Components

#### 2.1 Plaid OAuth Web Component (`common-plaid-oauth.ts`)

Key Features:

- Initialize Plaid Link SDK
- Handle Link token creation
- Manage OAuth flow
- Display connected accounts
- Support for multiple bank connections

Structure:

```typescript
export class CommonPlaidOauthElement extends LitElement {
  // Properties
  auth: Cell<PlaidAuthData>
  products: string[]
  isLoading: boolean
  linkToken: string
  
  // Methods
  async createLinkToken()
  async initializePlaidLink()
  async handlePlaidSuccess(publicToken, metadata)
  async handlePlaidExit(error, metadata)
  async removeAccount(itemId)
  
  // Render
  - Show connected accounts with balances
  - "Connect Bank Account" button
  - Account management options
}
```

### Phase 3: Recipe Integration

#### 3.1 Plaid Recipe (`plaid.tsx`)

A single comprehensive recipe that handles both accounts and transactions,
similar to the Gmail recipe structure.

Features:

- Display all connected bank accounts with balances
- Import and display transaction history
- Filter transactions by account, date range, category
- Incremental sync support for new transactions
- Manual refresh functionality
- Remove account connections
- Export both account and transaction data

Schema:

```typescript
const PlaidImporterInputs = {
  type: "object",
  properties: {
    settings: {
      type: "object",
      properties: {
        products: {
          type: "array",
          items: { type: "string" },
          default: ["accounts", "transactions", "identity"],
          description: "Plaid products to request",
        },
        daysToSync: {
          type: "number",
          default: 90,
          description: "Number of days of transactions to sync",
        },
        lastSyncCursor: {
          type: "string",
          default: "",
          description: "Cursor for incremental transaction sync",
        },
      },
      required: ["products", "daysToSync", "lastSyncCursor"],
    },
    auth: PlaidAuthSchema,
  },
  required: ["settings", "auth"],
  description: "Plaid Importer",
};

const ResultSchema = {
  type: "object",
  properties: {
    accounts: {
      type: "array",
      items: AccountSchema,
    },
    transactions: {
      type: "array",
      items: TransactionSchema,
    },
    plaidUpdater: { asStream: true, type: "object", properties: {} },
  },
};
```

The recipe will include:

- `<common-plaid-oauth>` component for authentication
- Account listing with current balances
- Transaction table with filtering options
- Manual sync button
- Settings for sync preferences

Key Implementation Details:

```typescript
export default recipe(
  PlaidImporterInputs,
  ResultSchema,
  ({ settings, auth }) => {
    const accounts = cell<Account[]>([]);
    const transactions = cell<Transaction[]>([]);

    // Handler for syncing data
    const plaidUpdater = handler(
      {},
      {
        type: "object",
        properties: {
          accounts: { type: "array", items: AccountSchema, asCell: true },
          transactions: {
            type: "array",
            items: TransactionSchema,
            asCell: true,
          },
          auth: { ...PlaidAuthSchema, asCell: true },
          settings: {
            ...PlaidImporterInputs.properties.settings,
            asCell: true,
          },
        },
      },
      async (_event, state) => {
        // Sync logic similar to googleUpdater in gmail.tsx
        // Fetch accounts and transactions for all connected items
        // Handle incremental sync using cursor
      },
    );

    return {
      [NAME]: str`Plaid Banking`,
      [UI]: (
        <div>
          <common-plaid-oauth
            $auth={auth}
            products={settings.products}
          />
          {/* Account and transaction displays */}
        </div>
      ),
      accounts,
      transactions,
      bgUpdater: plaidUpdater({ accounts, transactions, auth, settings }),
    };
  },
);
```

### Phase 4: Key Implementation Considerations

#### 4.1 Security

- Store access tokens with proper classification (secret)
- Never expose access tokens to frontend
- Validate all state parameters
- Use HTTPS for all callbacks

#### 4.2 Error Handling

- Handle Plaid-specific errors (ITEM_LOGIN_REQUIRED, etc.)
- Implement reconnection flow for expired consent
- Graceful degradation for missing products

#### 4.3 Data Sync Strategy

- Use webhooks for real-time updates (optional)
- Implement manual refresh functionality
- Cache account data with timestamps
- Handle rate limits appropriately

#### 4.4 Multi-Item Support

- Support multiple bank connections per user
- Store items in array structure
- Handle item-specific operations

### Phase 5: Testing Strategy

1. **Sandbox Testing**
   - Use Plaid sandbox credentials
   - Test all supported institutions
   - Verify error scenarios

2. **Integration Testing**
   - Test Link token creation
   - Verify OAuth callback handling
   - Test data persistence

3. **Recipe Testing**
   - Verify data flow between components
   - Test refresh mechanisms
   - Validate data export

### Phase 6: Documentation

1. **Developer Documentation**
   - API endpoint documentation
   - Schema definitions
   - Error code reference

2. **User Documentation**
   - How to connect bank accounts
   - Security information
   - Troubleshooting guide

## Timeline Estimate

- **Phase 1**: Backend Infrastructure (2-3 days)
- **Phase 2**: Frontend Components (1-2 days)
- **Phase 3**: Recipe Integration (1-2 days) - Reduced since we're building one
  recipe instead of two
- **Phase 4**: Security & Error Handling (1 day)
- **Phase 5**: Testing (1-2 days)
- **Phase 6**: Documentation (1 day)

**Total**: 7-10 days

## Dependencies

1. **NPM Packages**
   - `plaid` - Official Plaid Node SDK
   - Existing oauth2-client package (for utilities)

2. **Environment Setup**
   - Plaid API credentials
   - Webhook endpoint (optional)
   - HTTPS redirect URI

## Success Criteria

1. Users can connect bank accounts via Plaid Link
2. Account and transaction data successfully imported
3. Secure storage of access tokens
4. Graceful error handling
5. Support for reconnection flows
6. Integration with recipe framework
7. Comprehensive test coverage
