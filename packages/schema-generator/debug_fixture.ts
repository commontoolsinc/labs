import { createSchemaTransformerV2 } from "./src/plugin.ts";
import { getTypeFromCode, normalizeSchema } from "./test/utils.ts";

// Usage: deno run --allow-all debug_fixture.ts [fixture_name]
// Example: deno run --allow-all debug_fixture.ts stream_type
const fixtureName = Deno.args[0] || "default_type";

try {
  const code = await Deno.readTextFile(`./test/fixtures/schema/${fixtureName}.input.ts`);
  const expected = await Deno.readTextFile(`./test/fixtures/schema/${fixtureName}.expected.json`);

  const gen = createSchemaTransformerV2();
  const { type, checker, typeNode } = await getTypeFromCode(code, "SchemaRoot");
  const obj1 = normalizeSchema(gen(type, checker, typeNode));
  
  // Exact test harness logic
  const s1 = JSON.stringify(obj1, null, 2) + "\n";

  console.log(`=== DEBUGGING FIXTURE: ${fixtureName} ===`);
  console.log("Test result length:", s1.length);
  console.log("Expected length:", expected.length);
  console.log("Strings equal:", s1 === expected);

  if (s1 !== expected) {
    console.log("\n=== LAST 30 CHARS COMPARISON ===");
    console.log("Test result:", JSON.stringify(s1.slice(-30)));
    console.log("Expected:   ", JSON.stringify(expected.slice(-30)));

    console.log("\n=== BYTE-BY-BYTE ANALYSIS ===");
    const s1Bytes = new TextEncoder().encode(s1);
    const expectedBytes = new TextEncoder().encode(expected);
    
    const minLength = Math.min(s1Bytes.length, expectedBytes.length);
    let foundDifference = false;
    
    for (let i = 0; i < minLength; i++) {
      if (s1Bytes[i] !== expectedBytes[i]) {
        console.log(`First difference at byte ${i}:`);
        console.log(`  Test result: ${s1Bytes[i]} (char: '${String.fromCharCode(s1Bytes[i])}')`);
        console.log(`  Expected:    ${expectedBytes[i]} (char: '${String.fromCharCode(expectedBytes[i])}')`);
        foundDifference = true;
        break;
      }
    }
    
    if (!foundDifference && s1Bytes.length !== expectedBytes.length) {
      console.log("Length mismatch - no byte differences found in common portion");
      if (s1Bytes.length > expectedBytes.length) {
        console.log("Test result has extra bytes:");
        for (let i = expectedBytes.length; i < Math.min(s1Bytes.length, expectedBytes.length + 10); i++) {
          console.log(`  Byte ${i}: ${s1Bytes[i]} (char: '${String.fromCharCode(s1Bytes[i])}')`);
        }
      } else {
        console.log("Expected has extra bytes:");
        for (let i = s1Bytes.length; i < Math.min(expectedBytes.length, s1Bytes.length + 10); i++) {
          console.log(`  Byte ${i}: ${expectedBytes[i]} (char: '${String.fromCharCode(expectedBytes[i])}')`);
        }
      }
    }

    console.log("\n=== FULL TEST RESULT ===");
    console.log(s1);
    console.log("\n=== FULL EXPECTED ===");
    console.log(expected);
  } else {
    console.log("✅ Fixture content matches perfectly!");
  }

} catch (error) {
  console.error(`❌ Error debugging fixture '${fixtureName}':`, error.message);
}