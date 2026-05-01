# 1hour.guide

Deployment site for **[1hour.guide](https://1hour.guide)** — Learn anything in 1 hour.

This repository is a **thin deployment layer** that combines:
- **Framework**: [jiusanzhou/tutorial-kit](https://github.com/jiusanzhou/tutorial-kit) (as `framework/` submodule)
- **Content**: [jiusanzhou/1hour-guide-content](https://github.com/jiusanzhou/1hour-guide-content) (as `content/` submodule)

## Structure

```
1hour-guide/
├─ framework/          # tutorial-kit submodule (Next.js app)
├─ content/            # 1hour-guide-content submodule (MDX tutorials)
├─ build.sh            # Cloudflare Pages build script
├─ package.json        # Convenience scripts
└─ README.md
```

## Local Development

### First time setup

```bash
git clone --recurse-submodules https://github.com/jiusanzhou/1hour-guide.git
cd 1hour-guide
cd framework && pnpm install
```

If you forgot `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### Build

```bash
./build.sh
```

Or step by step:

```bash
cd framework
CONTENT_DIR=../../content pnpm build
```

### Preview

```bash
pnpm preview
# Open http://localhost:8000
```

### Dev server

```bash
cd framework
CONTENT_DIR=../../content pnpm dev
```

## Updating

### Pull latest content

```bash
pnpm update:content
git push
```

### Pull latest framework

```bash
pnpm update:framework
git push
```

## Deployment (Cloudflare Pages)

### Setup

1. Go to [Cloudflare Dashboard → Pages](https://dash.cloudflare.com)
2. Create a new project → **Connect to Git**
3. Select this repository
4. **Build settings**:

| Field | Value |
|-------|-------|
| Production branch | `main` |
| Framework preset | **None** |
| Build command | `./build.sh` |
| Build output directory | `out` |
| Root directory | `/` |

5. **Environment variables** (optional):
   - `NODE_VERSION`: `22`

6. **Important**: Enable **Include submodules** in the Git settings.

### Auto-deploy on content update

When content is updated in `1hour-guide-content`:
1. Update this repo's submodule: `pnpm update:content`
2. Push to `main`
3. Cloudflare rebuilds automatically

Or set up a GitHub Action to auto-bump submodules on content pushes (see `.github/workflows/bump-content.yml` — TODO).

## Custom Domain

1. Cloudflare Pages → Your project → **Custom domains** → **Set up a custom domain**
2. Add `1hour.guide` (and `www.1hour.guide` if desired)
3. If your domain uses Cloudflare DNS: auto-configured
4. Otherwise: add CNAME `1hour-guide.pages.dev`

## License

Content: CC BY-SA 4.0
Framework: MIT
