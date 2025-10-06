# Documentation Build Process

This directory contains the MyST documentation that gets built and deployed to https://docs.commontools.dev

## Overview

While the main codebase uses Deno, the documentation is built using MyST (mystmd), which is a Node.js-based static site generator for scientific and technical documentation.

## GitHub Actions Deployment

The documentation is automatically built and deployed via GitHub Actions when:
- Changes are pushed to the `main` branch
- The changes affect files in the `tutorials/` directory
- Or when manually triggered via workflow dispatch

The workflow is defined in `.github/workflows/deploy-docs.yml`

## Local Development

To work on the documentation locally, you'll need Node.js (not Deno) for MyST:

```bash
# Navigate to tutorials directory
cd tutorials

# Install dependencies (requires Node.js)
npm install

# Start development server
npm run dev

# Build static site
npm run build
```

## Configuration

- **MyST Config**: `myst.yml` - Defines the site structure and settings
- **Custom Domain**: The CNAME file configures the custom domain (docs.commontools.dev)
- **GitHub Pages**: The site is deployed to GitHub Pages with the custom domain

## Important Notes

1. The MyST build process is completely separate from the Deno-based application code
2. The GitHub Action uses Node.js to build the documentation
3. The built HTML is deployed to GitHub Pages
4. Make sure to configure DNS records to point `docs.commontools.dev` to GitHub Pages

## DNS Configuration Required

For the custom domain to work, you need to configure DNS:
- Add a CNAME record pointing `docs.commontools.dev` to `<username>.github.io`
- Or configure it according to GitHub's custom domain documentation