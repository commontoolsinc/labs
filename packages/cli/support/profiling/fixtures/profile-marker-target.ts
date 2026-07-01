console.log("profile start");
console.log("profile stop");

// Wait for the test cleanup to close stdin.
await new Response(Deno.stdin.readable).arrayBuffer();
