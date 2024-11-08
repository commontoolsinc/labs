import { sha256 } from "../src/utils/hash.ts";

async function test() {
  const content = `This is a test blob created at ${new Date().toISOString()}`;
  const hash = await sha256(content);
  const exampleEmail = "test@example.com";
  
  console.log("Content:", content);
  console.log("Hash:", hash);

  // PUT the blob
  console.log("\nPutting blob...");
  const putResponse = await fetch(`http://localhost:3000/blob/${hash}`, {
    method: "PUT",
    body: content,
    headers: {
      "Tailscale-User-Login": exampleEmail,
    },
  });

  console.log("PUT Status:", putResponse.status);
  console.log("PUT Response:", await putResponse.json());

  // GET the blob
  console.log("\nGetting blob...");
  const getResponse = await fetch(`http://localhost:3000/blob/${hash}`, {
    headers: {
      "Tailscale-User-Login": exampleEmail,
    },
  });

  console.log("GET Status:", getResponse.status);
  console.log("GET Content:", await getResponse.text());

  // List ALL blobs
  console.log("\nListing all blobs...");
  const allBlobsResponse = await fetch("http://localhost:3000/blobs", {
    headers: {
      "Tailscale-User-Login": exampleEmail,
    },
  });

  console.log("LIST ALL Status:", allBlobsResponse.status);
  console.log("LIST ALL Response:", await allBlobsResponse.json());

  // List blobs for specific user
  console.log(`\nListing blobs for user ${exampleEmail}...`);
  const userBlobsResponse = await fetch(`http://localhost:3000/blobs?user=${exampleEmail}`, {
    headers: {
      "Tailscale-User-Login": exampleEmail,
    },
  });

  console.log("LIST USER Status:", userBlobsResponse.status);
  console.log("LIST USER Response:", await userBlobsResponse.json());
}

test().catch(console.error); 