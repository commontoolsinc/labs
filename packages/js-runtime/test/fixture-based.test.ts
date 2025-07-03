import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { compareFixtureTransformation } from "./test-utils.ts";
import { cache } from "@commontools/static";
import { walk } from "@std/fs/walk";
import { relative, dirname, basename } from "@std/path";

// Configuration for each fixture directory
interface FixtureConfig {
  directory: string;
  describe: string;
  transformerOptions?: any;
  // Map file patterns to test group names
  groups?: Array<{
    pattern: RegExp;
    name: string;
  }>;
  // Custom test name formatter
  formatTestName?: (fileName: string) => string;
  // Skip certain files
  skip?: string[];
}

const configs: FixtureConfig[] = [
  {
    directory: "handler-schema",
    describe: "Handler Schema Transformation",
    transformerOptions: { applySchemaTransformer: true },
    formatTestName: (name) => `transforms ${name.replace(/-/g, ' ')}`,
  },
  {
    directory: "opaque-refs",
    describe: "OpaqueRef Transformer",
    groups: [
      { pattern: /ternary/, name: "Ternary Transformations" },
      { pattern: /binary/, name: "Binary Expression Transformations" },
      { pattern: /function-calls|complex-function/, name: "Function Call Transformations" },
      { pattern: /property-access/, name: "Property Access and Method Calls" },
      { pattern: /jsx/, name: "JSX Expression Transformations" },
      { pattern: /handler/, name: "Handler Transformations" },
      { pattern: /multiple-refs|same-ref/, name: "Multiple OpaqueRef Operations" },
    ],
    formatTestName: (name) => {
      const formatted = name.replace(/-/g, ' ');
      // Add context based on the fixture name
      if (name.includes('no-transform')) return `does not transform ${formatted.replace('no transform ', '')}`;
      if (name.includes('nested')) return `handles ${formatted}`;
      return `transforms ${formatted}`;
    },
  },
  {
    directory: "jsx-expressions", 
    describe: "JSX Expression Transformer",
    formatTestName: (name) => {
      const formatted = name.replace(/-/g, ' ');
      if (name.includes('no-transform')) return `does not transform ${formatted.replace('no transform ', '')}`;
      return `transforms ${formatted}`;
    },
  },
  {
    directory: "schema-transform",
    describe: "Schema Transformer",
    transformerOptions: { applySchemaTransformer: true },
    formatTestName: (name) => {
      const formatted = name.replace(/-/g, ' ');
      if (name === 'no-directive') return 'skips transformation without /// <cts-enable /> directive';
      if (name === 'with-opaque-ref') return 'works with OpaqueRef transformer';
      return `transforms ${formatted}`;
    },
    skip: ['no-directive'], // This one needs special handling with compiler
  },
  {
    directory: "transformations/ifelse",
    describe: "IfElse Transformer",
    formatTestName: (name) => `transforms ${name.replace(/-/g, ' ')}`,
  },
];

// Collect all fixtures before generating tests
async function collectFixtures(config: FixtureConfig) {
  const inputFiles: string[] = [];
  
  for await (const entry of walk(`test/fixtures/${config.directory}`, {
    exts: [".ts", ".tsx"],
    match: [/\.input\.(ts|tsx)$/],
  })) {
    const relativePath = relative(`test/fixtures/${config.directory}`, entry.path);
    const baseName = basename(relativePath, basename(relativePath).includes('.tsx') ? '.input.tsx' : '.input.ts');
    
    if (config.skip?.includes(baseName)) continue;
    
    inputFiles.push(baseName);
  }
  
  return inputFiles;
}

// Determine file extension
async function getFileExtension(basePath: string): Promise<string> {
  try {
    await Deno.stat(`test/${basePath}.tsx`);
    return '.tsx';
  } catch {
    return '.ts';
  }
}

// Get type definitions once
const commontools = await cache.getText("types/commontools.d.ts");

// Collect all fixtures first
const configsWithFixtures = await Promise.all(
  configs.map(async (config) => ({
    ...config,
    fixtures: await collectFixtures(config),
  }))
);

// Generate tests for each configuration
for (const config of configsWithFixtures) {
  describe(config.describe, () => {
    // Group fixtures by pattern if groups are defined
    const fixtureGroups = new Map<string, string[]>();
    const ungroupedFixtures: string[] = [];
    
    // Sort files into groups
    for (const fileName of config.fixtures) {
      let grouped = false;
      
      if (config.groups) {
        for (const group of config.groups) {
          if (group.pattern.test(fileName)) {
            if (!fixtureGroups.has(group.name)) {
              fixtureGroups.set(group.name, []);
            }
            fixtureGroups.get(group.name)!.push(fileName);
            grouped = true;
            break;
          }
        }
      }
      
      if (!grouped) {
        ungroupedFixtures.push(fileName);
      }
    }
    
    // Generate tests for grouped fixtures
    for (const [groupName, fixtures] of fixtureGroups) {
      describe(groupName, () => {
        for (const fixture of fixtures.sort()) {
          const testName = config.formatTestName?.(fixture) || fixture;
          
          it(testName, async () => {
            const inputPath = `${config.directory}/${fixture}`;
            const ext = await getFileExtension(`fixtures/${inputPath}.input`);
            
            const result = await compareFixtureTransformation(
              `${inputPath}.input${ext}`,
              `${inputPath}.expected${ext}`,
              { 
                types: { "commontools.d.ts": commontools },
                ...config.transformerOptions 
              }
            );
            
            if (!result.matches) {
              console.log("Expected:", result.expected);
              console.log("Actual:", result.actual);
            }
            expect(result.matches).toBe(true);
          });
        }
      });
    }
    
    // Generate tests for ungrouped fixtures
    for (const fixture of ungroupedFixtures.sort()) {
      const testName = config.formatTestName?.(fixture) || fixture;
      
      it(testName, async () => {
        const inputPath = `${config.directory}/${fixture}`;
        const ext = await getFileExtension(`fixtures/${inputPath}.input`);
        
        const result = await compareFixtureTransformation(
          `${inputPath}.input${ext}`,
          `${inputPath}.expected${ext}`,
          { 
            types: { "commontools.d.ts": commontools },
            ...config.transformerOptions 
          }
        );
        
        if (!result.matches) {
          console.log("Expected:", result.expected);
          console.log("Actual:", result.actual);
        }
        expect(result.matches).toBe(true);
      });
    }
  });
}

// Special handling for tests that need the compiler
describe("Schema Transformer - Compiler Tests", () => {
  it("skips transformation without /// <cts-enable /> directive", async () => {
    const { getTypeScriptEnvironmentTypes, TypeScriptCompiler } = await import("../mod.ts");
    const types = await getTypeScriptEnvironmentTypes();
    const typeLibs = { ...types, commontools };
    const compiler = new TypeScriptCompiler(typeLibs);
    
    const inputContent = await Deno.readTextFile("test/fixtures/schema-transform/no-directive.input.ts");
    
    const program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: inputContent,
        },
        {
          name: "commontools.d.ts",
          contents: commontools,
        },
      ],
    };

    const compiled = compiler.compile(program, {
      runtimeModules: ["commontools"],
    });

    // Should NOT transform without the directive
    expect(compiled.js).toContain("commontools_1.toSchema)(");
    expect(compiled.js).not.toContain('"type":"object"');
    expect(compiled.js).not.toContain('"properties"');
    expect(compiled.js).not.toContain("satisfies");
  });
});