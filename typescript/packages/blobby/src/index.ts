import { Hono } from "hono";
import { cors } from "hono/cors";
// import { createHash } from 'crypto'

const html = `<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Upload Content</title>
</head>

<body>
    <h1>Upload Content</h1>
    <textarea id="content" rows="10" cols="50"></textarea><br>
    <button onclick="upload()">Upload</button>
    <p id="result"></p>

    <script>
        async function upload() {
            const content = document.getElementById('content').value;
            
            // Calculate SHA-256 hash
            const msgBuffer = new TextEncoder().encode(content);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            
            // Send content to /:hash endpoint
            const response = await fetch(\`/\${hash}\`, {
                method: 'POST',
                body: content
            });
            
            const data = await response.json();
            const link = \`\${window.location.origin}/\${hash}\`;
            document.getElementById('result').innerHTML = \`Your link: <a href="\${link}">\${link}</a>\`;
        }
    </script>
</body>

</html>`;

const app = new Hono();

// Add CORS middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Kuma-Revision"],
    maxAge: 600,
    credentials: true,
  }),
);

app.get("/upload", (c) => {
  return c.html(html);
});

app.get("/:hash", async (c) => {
  const hash = c.req.param("hash");
  const object = await c.env.R2.get(hash);

  if (!object) {
    return c.text("Not Found", 404);
  }

  return c.body(object.body);
});

app.post("/:hash", async (c) => {
  const hash = c.req.param("hash");
  const content = await c.req.text();
  // FIXME(ja): verify the hash of the content is correct
  // const hash = createHash('sha256').update(content).digest('hex')

  await c.env.R2.put(hash, content);

  return c.json({ hash });
});

export default app;
