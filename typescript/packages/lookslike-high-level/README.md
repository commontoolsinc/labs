# Sketch

Use `npm run dev` to start the Vite server.
Use `npm run build --watch` to build this and dependent packages in watch mode.

## LLM Interop and Collectathon

The LLM functionality relies on the `planning-server` package. The Collectathon
functionality relies on the `collectathon` package. Follow the README in each to
start them and requests will automatically be proxied to the servers in
development (via `vite.config.js`).
