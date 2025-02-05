# Jumble

Jumble is a react app for commontools.

It uses vite to build/bundle the frontend. We've also got some tauri app boilerplate to give us the ability to package the react app as a native macos and ios app.

## Development

To start the react app, run the following commands:

```bash
cd ./typescript/packages/jumble
pnpm install
pnpm run dev
```

To start the tauri desktop app, run the following commands:

```bash
cd ./typescript/packages/jumble
pnpm install
pnpm tauri dev
```
