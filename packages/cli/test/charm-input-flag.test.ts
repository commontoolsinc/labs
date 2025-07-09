import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Command } from "@cliffy/command";
import { charm } from "../commands/charm.ts";

describe("charm command --input flag", () => {
  it("should parse --input flag for get command", async () => {
    // Test that the get command accepts --input flag
    const getCommand = charm.getCommand("get")!;
    const options = getCommand.getOptions();
    
    const inputOption = options.find(opt => opt.flags.includes("--input"));
    expect(inputOption).toBeDefined();
    expect(inputOption?.description).toContain("input cell");
  });

  it("should parse --input flag for set command", async () => {
    // Test that the set command accepts --input flag
    const setCommand = charm.getCommand("set")!;
    const options = setCommand.getOptions();
    
    const inputOption = options.find(opt => opt.flags.includes("--input"));
    expect(inputOption).toBeDefined();
    expect(inputOption?.description).toContain("input cell");
  });

  it("should have correct examples for get command", () => {
    const getCommand = charm.getCommand("get")!;
    const examples = getCommand.getExamples();
    
    // Should have an example with --input flag
    const hasInputExample = examples.some(ex => 
      ex.name.includes("--input")
    );
    expect(hasInputExample).toBe(true);
  });

  it("should have correct examples for set command", () => {
    const setCommand = charm.getCommand("set")!;
    const examples = setCommand.getExamples();
    
    // Should have an example with --input flag
    const hasInputExample = examples.some(ex => 
      ex.name.includes("--input")
    );
    expect(hasInputExample).toBe(true);
  });
});