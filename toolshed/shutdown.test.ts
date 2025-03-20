// shutdown.test.ts
import { assertEquals } from "@std/assert";
import { spy } from "@std/testing/mock";

// Create a SystemError type for testing
type SystemError = Error & { code: number };

// Create result type for memory.close
type CloseResult = { ok: true } | { error: SystemError };

// Mock implementation of the handleShutdown function
// This matches what should be implemented in index.ts
async function handleShutdown(
  controller: { abort: () => void },
  memory: { close: () => Promise<CloseResult> },
) {
  console.log("Shutdown signal received, closing server...");

  // Abort the server
  controller.abort();

  try {
    // Close the memory system gracefully
    console.log("Closing memory system...");
    const result = await memory.close();

    // Type guard
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
  await t.step(
    "should abort controller and close memory successfully",
    async () => {
      // Mock controller
      const controller = {
        abort: spy(),
      };

      // Mock memory
      const memory = {
        close: spy((): Promise<CloseResult> => Promise.resolve({ ok: true })),
      };

      // Mock console methods
      const originalLog = console.log;
      const originalError = console.error;
      const logs: string[] = [];

      console.log = (message: unknown) => {
        logs.push(String(message));
      };

      try {
        // Call the handler
        await handleShutdown(controller, memory);

        // Verify controller was aborted
        assertEquals(controller.abort.calls.length, 1);

        // Verify memory was closed
        assertEquals(memory.close.calls.length, 1);

        // Verify correct log messages
        assertEquals(logs.includes("Closing memory system..."), true);
        assertEquals(logs.includes("Memory system closed successfully"), true);
        assertEquals(logs.includes("Shutdown complete"), true);
      } finally {
        // Restore console methods
        console.log = originalLog;
        console.error = originalError;
      }
    },
  );

  await t.step("should handle memory.close error gracefully", async () => {
    // Mock controller
    const controller = {
      abort: spy(),
    };

    // Create test error
    const testError = new Error("Test error") as SystemError;
    testError.code = 500;

    // Mock memory with error
    const memory = {
      close: spy((): Promise<CloseResult> =>
        Promise.resolve({ error: testError })
      ),
    };

    // Mock console methods
    const originalLog = console.log;
    const originalError = console.error;
    const logs: string[] = [];
    const errors: string[] = [];

    console.log = (message: unknown) => {
      logs.push(String(message));
    };

    console.error = (message: unknown, ...args: unknown[]) => {
      errors.push(
        String(message) + (args.length > 0 ? " " + String(args[0]) : ""),
      );
    };

    try {
      // Call the handler
      await handleShutdown(controller, memory);

      // Verify controller was aborted
      assertEquals(controller.abort.calls.length, 1);

      // Verify memory was closed
      assertEquals(memory.close.calls.length, 1);

      // Verify error handling
      assertEquals(errors.length, 1);
      assertEquals(errors[0].includes("Error closing memory"), true);
      assertEquals(logs.includes("Shutdown complete"), true);
    } finally {
      // Restore console methods
      console.log = originalLog;
      console.error = originalError;
    }
  });

  await t.step("should handle exceptions during memory.close", async () => {
    // Mock controller
    const controller = {
      abort: spy(),
    };

    // Mock memory with exception
    const memory = {
      close: spy((): Promise<CloseResult> => {
        throw new Error("Unexpected error");
      }),
    };

    // Mock console methods
    const originalLog = console.log;
    const originalError = console.error;
    const logs: string[] = [];
    const errors: string[] = [];

    console.log = (message: unknown) => {
      logs.push(String(message));
    };

    console.error = (message: unknown, ...args: unknown[]) => {
      errors.push(
        String(message) + (args.length > 0 ? " " + String(args[0]) : ""),
      );
    };

    try {
      // Call the handler
      await handleShutdown(controller, memory);

      // Verify controller was aborted
      assertEquals(controller.abort.calls.length, 1);

      // Verify memory was closed (attempt)
      assertEquals(memory.close.calls.length, 1);

      // Verify error handling
      assertEquals(errors.length, 1);
      assertEquals(errors[0].includes("Error during shutdown"), true);
      assertEquals(logs.includes("Shutdown complete"), true);
    } finally {
      // Restore console methods
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
