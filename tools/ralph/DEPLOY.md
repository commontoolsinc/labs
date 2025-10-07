# Deploying and Testing a Charm

This guide provides step-by-step instructions for deploying a charm locally and
testing it with Playwright.

## Step 1: Create an Identity Key

First, create an identity key if one doesn't exist:

```bash
NO_COLOR=1 deno task ct id new > my.key
```

**Important:** Do NOT add `2>&1` to this command - it will corrupt the key file
by mixing error output with the actual key.

This creates a new identity key file named `my.key` in the current directory.

## Step 2: Deploy the Charm

Deploy a charm to localhost using the `ct charm new` command:

```bash
deno task ct charm new --identity ./my.key --api-url http://127.0.0.1:8000 --space <SPACE_NAME> <PATH_TO_CHARM_FILE>
```

Example:

```bash
deno task ct charm new --identity ./my.key --api-url http://127.0.0.1:8000 --space ellyse ./packages/patterns/counter.tsx
```

The command will output a charm ID (e.g.,
`baedreidon464mghox4uar46bbym5t6bnmlvn6wwzby5vvdmsw24oxaalp4`).

## Step 3: Construct the URL

The URL format for localhost is:

```
http://localhost:5173/<SPACE_NAME>/<CHARM_ID>
```

Example:

```
http://localhost:5173/ellyse/baedreidon464mghox4uar46bbym5t6bnmlvn6wwzby5vvdmsw24oxaalp4
```

## Step 4: Test with Playwright

### 4.1 Navigate to the Charm URL

```javascript
await page.goto("http://localhost:5173/<SPACE_NAME>/<CHARM_ID>");
```

### 4.2 Register/Login (First Time Only)

When you first visit, you'll see a login page. Register with a passphrase:

1. Click the "➕ Register" button
2. Click the "🔑 Generate Passphrase" button
3. Click the "🔒 I've Saved It - Continue" button

This will log you in and load the charm.

### 4.3 Test the Charm

Once logged in, you can interact with the charm using Playwright commands.

## Complete Example

```bash
# 1. Create identity key (if needed)
deno task ct id new > my.key

# 2. Deploy charm
deno task ct charm new --identity ./my.key --api-url http://127.0.0.1:8000 --space ellyse ./packages/patterns/counter.tsx

# Output: baedreidon464mghox4uar46bbym5t6bnmlvn6wwzby5vvdmsw24oxaalp4

# 3. URL will be:
# http://localhost:5173/ellyse/baedreidon464mghox4uar46bbym5t6bnmlvn6wwzby5vvdmsw24oxaalp4
```

Then use Playwright to:

1. Navigate to the URL
2. Complete registration (first time)
3. Test the charm functionality
