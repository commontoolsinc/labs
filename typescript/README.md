Use pnpm for the non-deno based code in ./packages

This provides test/dev/build experience that works accross a shared "workspace",
allowing changes in one package to trigger reload/rebuild flows in each

See https://pnpm.io/installation

## Commmon Tasks

 - Add Dependency: `pnpm add ____`
 - Install Dependencies: `pnpm install`
 - Run Tests: `pnpm run test`
 - Dev Mode (vitejs server): `pnpm run dev`
