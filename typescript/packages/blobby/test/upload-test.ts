import { sha256 } from "../src/utils/hash.ts";

const BASE_URL = Deno.env.get("BASE_URL") || "http://localhost:3000";

async function test() {
  const content = `This is a test blob created at ${new Date().toISOString()}`;
  const hash = await sha256(content);
  const exampleEmail = "test@example.com";
  
  console.log("Testing against:", BASE_URL);
  console.log("Content:", content);
  console.log("Hash:", hash);

  // POST the blob
  console.log("\nPOSTing blob...");
  const postResponse = await fetch(`${BASE_URL}/blob/${hash}`, {
    method: "POST",
    body: content,
    headers: {
      "Tailscale-User-Login": exampleEmail,
    },
  });

  console.log("POST Status:", postResponse.status);
  console.log("POST Response:", await postResponse.json());

  // GET the blob
  console.log("\nGetting blob...");
  const getResponse = await fetch(`${BASE_URL}/blob/${hash}`, {
    headers: {
      "Tailscale-User-Login": exampleEmail,
    },
  });

  console.log("GET Status:", getResponse.status);
  console.log("GET Content:", await getResponse.text());

  // List ALL blobs
  console.log("\nListing all blobs...");
  const allBlobsResponse = await fetch(`${BASE_URL}/blobs?all=true`, {
    headers: {
      "Tailscale-User-Login": exampleEmail,
    },
  });

  console.log("LIST ALL Status:", allBlobsResponse.status);
  console.log("LIST ALL Response:", await allBlobsResponse.json());

  // List blobs for specific user
  console.log(`\nListing blobs for user ${exampleEmail}...`);
  const userBlobsResponse = await fetch(`${BASE_URL}/blobs`, {
    headers: {
      "Tailscale-User-Login": exampleEmail,
    },
  });

  console.log("LIST USER Status:", userBlobsResponse.status);
  console.log("LIST USER Response:", await userBlobsResponse.json());
}

test().catch(console.error); 