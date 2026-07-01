const releaseListener = Deno.listen({
  hostname: "127.0.0.1",
  port: 0,
});
const releaseAddr = releaseListener.addr;
if (releaseAddr.transport !== "tcp") {
  throw new Error("Expected a TCP release listener");
}
await Deno.stderr.write(
  new TextEncoder().encode(`profile release port ${releaseAddr.port}\n`),
);

console.log("profile start");
console.log("profile stop");

// Wait for the test to open the release socket.
try {
  const releaseConnection = await releaseListener.accept();
  releaseConnection.close();
} finally {
  releaseListener.close();
}
