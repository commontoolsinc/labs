import { env } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

type ClaimStatus = "submitted" | "approved" | "rejected" | "paid";

interface ExpenseClaimInput {
  id?: string;
  employee?: string;
  description?: string;
  amount?: number;
  status?: string;
}

interface ExpenseClaim {
  id: string;
  employee: string;
  description: string;
  amount: number;
  status: ClaimStatus;
}

interface ExpenseTotals {
  submitted: number;
  approved: number;
  rejected: number;
  paid: number;
  pendingPayment: number;
  totalRequested: number;
}

describe("expense reimbursement pattern test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: CharmsController;
  let charm: CharmController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "expense-reimbursement.pattern.tsx",
    );
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath),
      );
    charm = await cc.create(
      program,
      { start: true },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the expense reimbursement tracker and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    // Wait for UI to render
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Find heading
    const heading = await page.waitForSelector("h1", {
      strategy: "pierce",
    });
    assert(heading, "Should find heading element");

    const headingText = await heading.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(
      headingText?.trim(),
      "Expense Reimbursement",
      "Heading should be Expense Reimbursement",
    );

    // Verify initial state has default claims
    const claimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    assert(Array.isArray(claimList), "Claim list should be an array");
    assert(claimList.length >= 4, "Should have default claims");

    const claimCount = charm.result.get(["claimCount"]) as number;
    assertEquals(claimCount, claimList.length, "Claim count should match list length");
  });

  it("should calculate totals by status correctly", async () => {
    const totals = charm.result.get(["totals"]) as ExpenseTotals;

    assert(typeof totals.submitted === "number", "Should have submitted total");
    assert(typeof totals.approved === "number", "Should have approved total");
    assert(typeof totals.rejected === "number", "Should have rejected total");
    assert(typeof totals.paid === "number", "Should have paid total");
    assert(typeof totals.pendingPayment === "number", "Should have pending payment total");
    assert(typeof totals.totalRequested === "number", "Should have total requested");

    // Verify pending payment = approved (but not yet paid)
    const claimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const manualPending = claimList
      .filter(c => c.status === "approved")
      .reduce((sum, c) => sum + c.amount, 0);
    assert(
      Math.abs(totals.pendingPayment - manualPending) < 0.01,
      `Pending payment should match approved claims, got ${totals.pendingPayment} vs ${manualPending}`,
    );
  });

  it("should approve a claim via UI", async () => {
    const page = shell.page();

    // Wait for heading to ensure page is rendered
    await page.waitForSelector("h1", { strategy: "pierce" });

    // Get a submitted claim ID
    const claimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const submittedClaim = claimList.find(c => c.status === "submitted");
    assert(submittedClaim, "Should have at least one submitted claim");

    // Enter claim ID
    const claimIdInput = await page.waitForSelector("#claim-id", {
      strategy: "pierce",
    });
    assert(claimIdInput, "Should find claim ID input");

    const inputElement = await claimIdInput.waitForSelector("input", {
      strategy: "pierce",
    });
    await inputElement.click();
    await inputElement.evaluate((el: HTMLInputElement) => {
      el.value = "";
    });
    await inputElement.type(submittedClaim.id);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Click approve button
    const approveButton = await page.waitForSelector("#approve-claim-button", {
      strategy: "pierce",
    });
    assert(approveButton, "Should find approve button");
    await approveButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify claim status changed to approved
    const updatedClaimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const updatedClaim = updatedClaimList.find(c => c.id === submittedClaim.id);
    assertEquals(updatedClaim?.status, "approved", "Claim should be approved");

    // Verify totals updated
    const totals = charm.result.get(["totals"]) as ExpenseTotals;
    assert(totals.approved >= submittedClaim.amount, "Approved total should include the claim amount");
  });

  it("should reject a claim via UI", async () => {
    const page = shell.page();

    // Wait for heading to ensure page is rendered
    await page.waitForSelector("h1", { strategy: "pierce" });

    // Get another submitted claim ID
    const claimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const submittedClaim = claimList.find(c => c.status === "submitted");

    if (!submittedClaim) {
      console.log("No submitted claims remaining, skipping reject test");
      return;
    }

    // Enter claim ID
    const claimIdInput = await page.waitForSelector("#claim-id", {
      strategy: "pierce",
    });
    const inputElement = await claimIdInput.waitForSelector("input", {
      strategy: "pierce",
    });
    await inputElement.click();
    await inputElement.evaluate((el: HTMLInputElement) => {
      el.value = "";
    });
    await inputElement.type(submittedClaim.id);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Click reject button
    const rejectButton = await page.waitForSelector("#reject-claim-button", {
      strategy: "pierce",
    });
    await rejectButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify claim status changed to rejected
    const updatedClaimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const updatedClaim = updatedClaimList.find(c => c.id === submittedClaim.id);
    assertEquals(updatedClaim?.status, "rejected", "Claim should be rejected");

    // Verify totals updated
    const totals = charm.result.get(["totals"]) as ExpenseTotals;
    assert(totals.rejected >= submittedClaim.amount, "Rejected total should include the claim amount");
  });

  it("should record payment for approved claim via UI", async () => {
    const page = shell.page();

    // Wait for heading to ensure page is rendered
    await page.waitForSelector("h1", { strategy: "pierce" });

    // Get an approved claim ID
    const claimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const approvedClaim = claimList.find(c => c.status === "approved");
    assert(approvedClaim, "Should have at least one approved claim");

    // Enter claim ID
    const claimIdInput = await page.waitForSelector("#claim-id", {
      strategy: "pierce",
    });
    const inputElement = await claimIdInput.waitForSelector("input", {
      strategy: "pierce",
    });
    await inputElement.click();
    await inputElement.evaluate((el: HTMLInputElement) => {
      el.value = "";
    });
    await inputElement.type(approvedClaim.id);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Click record payment button
    const paymentButton = await page.waitForSelector("#record-payment-button", {
      strategy: "pierce",
    });
    await paymentButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify claim status changed to paid
    const updatedClaimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const updatedClaim = updatedClaimList.find(c => c.id === approvedClaim.id);
    assertEquals(updatedClaim?.status, "paid", "Claim should be paid");

    // Verify totals updated
    const totals = charm.result.get(["totals"]) as ExpenseTotals;
    assert(totals.paid >= approvedClaim.amount, "Paid total should include the claim amount");

    // Verify pending payment decreased
    const previousPending = approvedClaim.amount;
    assert(
      totals.pendingPayment < previousPending || totals.pendingPayment === 0,
      "Pending payment should decrease after recording payment",
    );
  });

  it("should add new claim via direct operation", async () => {
    // Get current claims
    const currentClaims = charm.result.get(["claims"]) as ExpenseClaimInput[];

    // Add a new claim
    const newClaim: ExpenseClaimInput = {
      id: "test-999",
      employee: "Test Employee",
      description: "Test expense",
      amount: 50,
      status: "submitted",
    };

    const updatedClaims = [...currentClaims, newClaim];
    await charm.result.set(updatedClaims, ["claims"]);

    // Wait for reactive updates - direct manipulation causes more conflicts
    await new Promise(resolve => setTimeout(resolve, 10000));

    const claimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const addedClaim = claimList.find(c => c.id === "test-999");
    assert(addedClaim, "New claim should be added");
    assertEquals(addedClaim.employee, "Test Employee");
    assertEquals(addedClaim.amount, 50);
    assertEquals(addedClaim.status, "submitted");
  });

  it("should update claim status via direct operation", async () => {
    // Get current claims
    const currentClaims = charm.result.get(["claims"]) as ExpenseClaimInput[];

    // Update the test claim to approved
    const updatedClaims = currentClaims.map(claim =>
      claim.id === "test-999"
        ? { ...claim, status: "approved" }
        : claim
    );

    await charm.result.set(updatedClaims, ["claims"]);

    // Wait for reactive updates - direct manipulation causes more conflicts
    await new Promise(resolve => setTimeout(resolve, 10000));

    const claimList = charm.result.get(["claimList"]) as ExpenseClaim[];
    const updatedClaim = claimList.find(c => c.id === "test-999");
    assertEquals(updatedClaim?.status, "approved", "Claim status should be updated to approved");

    // Verify totals recalculated
    const totals = charm.result.get(["totals"]) as ExpenseTotals;
    assert(totals.approved >= 50, "Approved total should include the test claim");
  });

  it("should track activity history", async () => {
    const history = charm.result.get(["activityLog"]) as string[];
    assert(Array.isArray(history), "Activity log should be an array");
    assert(history.length > 0, "Should have activity history");

    // Should have initialization message
    assert(
      history.some(entry => entry.includes("initialized")),
      "Should have initialization entry",
    );
  });

  it("should display latest action", async () => {
    const latestAction = charm.result.get(["latestAction"]) as string;
    assert(typeof latestAction === "string", "Latest action should be a string");
    assert(latestAction.length > 0, "Latest action should not be empty");
  });
});
