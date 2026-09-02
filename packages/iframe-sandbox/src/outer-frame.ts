import { CSP, HOST_ORIGIN } from "./csp.ts";
import script from "./outer-frame-script.js" with { type: "text" };

// The script is inlined into a `<script>` element, whose content ends at the
// first `</script>` however it got there, so the one thing the script's text
// cannot contain is checked here rather than trusted.
if (/<\/script/i.test(script)) {
  throw new Error("outer-frame-script.js must not contain `</script`.");
}

/**
 * The outer frame's document. It sets the Content Security Policy the guest
 * inherits, holds the inner frame, and runs the script, which is what loads
 * guests into that frame and talks to the host. The script reads the host's
 * origin off its own element; an origin is scheme, host and port, none of
 * which needs escaping in an attribute.
 */
export default `
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
<style>
html, body {
  padding: 0;
  margin: 0;
  height: 100vh;
  overflow: hidden;
  background-color: #ddd;
}

* {
  box-sizing: border-box;
}

iframe {
  padding: 0;
  margin: 0;
  height: 100vh;
  width: 100vw;
  border: none;
}
</style>
</head>
<body>
<iframe
  allow="clipboard-write"
  sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-modals"></iframe>
<script data-host-origin="${HOST_ORIGIN}">
${script}
</script>
</body>
</html>
`;
