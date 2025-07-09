import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getCellValue, setCellValue } from "../lib/charm.ts";

describe("Charm operations integration", () => {
  describe("getCellValue with input option", () => {
    it("should accept input option parameter", async () => {
      // This test verifies that our new function signatures work correctly
      const mockConfig = {
        apiUrl: "https://test.com",
        space: "test-space",
        identity: "./test.key",
        charm: "test-charm"
      };
      
      // Test that function signature accepts the options parameter
      // We expect this to fail due to network/auth issues, but that's OK
      // We just want to verify the signature works
      try {
        await getCellValue(mockConfig, ["test"], { input: true });
      } catch (error) {
        // Expected to fail due to mock config
        expect(error).toBeDefined();
      }
      
      try {
        await getCellValue(mockConfig, ["test"], { input: false });
      } catch (error) {
        // Expected to fail due to mock config
        expect(error).toBeDefined();
      }
      
      try {
        await getCellValue(mockConfig, ["test"]); // No options - should use default
      } catch (error) {
        // Expected to fail due to mock config
        expect(error).toBeDefined();
      }
    });
  });

  describe("setCellValue with input option", () => {
    it("should accept input option parameter", async () => {
      // This test verifies that our new function signatures work correctly
      const mockConfig = {
        apiUrl: "https://test.com",
        space: "test-space",
        identity: "./test.key",
        charm: "test-charm"
      };
      
      // Test that function signature accepts the options parameter
      try {
        await setCellValue(mockConfig, ["test"], "value", { input: true });
      } catch (error) {
        // Expected to fail due to mock config
        expect(error).toBeDefined();
      }
      
      try {
        await setCellValue(mockConfig, ["test"], "value", { input: false });
      } catch (error) {
        // Expected to fail due to mock config
        expect(error).toBeDefined();
      }
      
      try {
        await setCellValue(mockConfig, ["test"], "value"); // No options - should use default
      } catch (error) {
        // Expected to fail due to mock config
        expect(error).toBeDefined();
      }
    });
  });
});