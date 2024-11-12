# snap

Snap is a little http utility that spins up a headless browser (via [Playwright](https://playwright.dev/)) and takes screenshots of web pages.

You can request a screenshot from any web page via URL, or by providing a recipe ID.

```bash
curl http://localhost:3000/screenshot/https://color.lol
```

Or by providing a recipe ID:

```bash
curl http://localhost:3000/screenshot/recipe/baedreiazzq57kmkouvbgfi6o7zvuuqwj53so5z7ngx6ax7zwiwvxa6qdti
```

## Running snap

```bash
deno run --watch main.ts
```
