// index.test.ts
import { assertEquals } from "@std/assert";
import { spy } from "@std/testing/mock";

// Creating a SystemError type for testing
type SystemError = Error & { code: number };

// Define the return type for memory.close
type CloseResult = { ok: true } | { error: SystemError };

// Mock the memory module
const mockMemory = {
  close: spy((): Promise<CloseResult> => Promise.resolve({ ok: true })),
};

// Test implementation of our shutdown handler
async function testHandleShutdown(
  memory: { close: () => Promise<CloseResult> },
) {
  console.log("Shutdown signal received, closing server...");

  try {
    // Close the memory system gracefully
    console.log("Closing memory system...");
    const result = await memory.close();

    // Type guard to check if result has error property
    if ("error" in result) {
      console.error("Error closing memory:", result.error);
    } else {
      console.log("Memory system closed successfully");
    }
  } catch (err) {
    console.error("Error during shutdown:", err);
  }

  console.log("Shutdown complete");
}

Deno.test("Graceful shutdown handler", async (t) => {
  await t.step("should call memory.close and log success", async () => {
    // Save original console.log
    const originalLog = console.log;
    const logMessages: string[] = [];

    // Mock console.log
    console.log = (message: string) => {
      logMessages.push(message);
    };

    // Create a fresh spy for each test
    mockMemory.close = spy((): Promise<CloseResult> =>
      Promise.resolve({ ok: true })
    );

    // Call the shutdown handler
    await testHandleShutdown(mockMemory);

    // Assert memory.close was called
    assertEquals(mockMemory.close.calls.length, 1);

    // Assert correct logs were made
    assertEquals(logMessages.includes("Closing memory system..."), true);
    assertEquals(
      logMessages.includes("Memory system closed successfully"),
      true,
    );
    assertEquals(logMessages.includes("Shutdown complete"), true);

    // Restore console.log
    console.log = originalLog;
  });

  await t.step("should handle memory.close errors gracefully", async () => {
    // Save original console methods
    const originalLog = console.log;
    const originalError = console.error;
    const logMessages: string[] = [];
    const errorMessages: string[] = [];

    // Mock console methods
    console.log = (message: string) => {
      logMessages.push(message);
    };
    console.error = (message: string) => {
      errorMessages.push(message);
    };

    // Create error mock
    const testError = new Error("Test error") as SystemError;
    testError.code = 500;
    const errorMemory = {
      close: spy((): Promise<CloseResult> =>
        Promise.resolve({ error: testError })
      ),
    };

    // Call the shutdown handler with error response
    await testHandleShutdown(errorMemory);

    // Assert memory.close was called
    assertEquals(errorMemory.close.calls.length, 1);

    // Assert correct logs were made
    assertEquals(logMessages.includes("Closing memory system..."), true);
    assertEquals(errorMessages.length > 0, true);
    assertEquals(errorMessages[0].includes("Error closing memory"), true);
    assertEquals(logMessages.includes("Shutdown complete"), true);

    // Restore console methods
    console.log = originalLog;
    console.error = originalError;
  });

  await t.step("should handle exceptions during memory.close", async () => {
    // Save original console methods
    const originalLog = console.log;
    const originalError = console.error;
    const logMessages: string[] = [];
    const errorMessages: string[] = [];

    // Mock console methods
    console.log = (message: string) => {
      logMessages.push(message);
    };
    console.error = (message: string) => {
      errorMessages.push(message);
    };

    // Create exception mock
    const exceptionMemory = {
      close: spy((): Promise<CloseResult> => {
        throw new Error("Unexpected error");
      }),
    };

    // Call the shutdown handler with exception
    await testHandleShutdown(exceptionMemory);

    // Assert memory.close was called
    assertEquals(exceptionMemory.close.calls.length, 1);

    // Assert correct logs were made
    assertEquals(logMessages.includes("Closing memory system..."), true);
    assertEquals(errorMessages.length > 0, true);
    assertEquals(errorMessages[0].includes("Error during shutdown"), true);
    assertEquals(logMessages.includes("Shutdown complete"), true);

    // Restore console methods
    console.log = originalLog;
    console.error = originalError;
  });
});
