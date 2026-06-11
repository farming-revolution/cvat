# Upgrading CVAT with Farming Changes

This document describes how the farming fork of CVAT is structured on top of
upstream `cvat-ai/cvat`, and how to migrate the farming-specific changes to a
new upstream release.

## Repositories & remotes

- **Upstream**: https://github.com/cvat-ai/cvat
- **Fork**:     https://github.com/farming-revolution/cvat
- **Submodule**: https://github.com/farming-revolution/farming_cvat_models
  (mounted at `serverless/onnx/farming_cvat_models`)

Local clone remotes:

```
origin    git@github.com:farming-revolution/cvat.git   (fetch / push)
upstream  https://github.com/cvat-ai/cvat.git          (fetch / push)
```

## Branch naming

One long-lived branch per upstream release tag:

```
farming/v<UPSTREAM_VERSION>
```

Example: `farming/v2.64.0` is the farming branch based on upstream tag `v2.64.0`.

## Current farming branch: `farming/v2.64.0`

All farming changes are collapsed into a **single squashed commit** on top of
upstream tag `v2.64.0`. This keeps future upgrades trivial — only one commit
has to be replayed onto the next upstream tag.

The overlay commit's hash is intentionally **not** pinned in this document
(every doc edit changes that hash, so any value here would be self-
invalidating). Instead, look it up live:

```bash
git fetch upstream --tags origin
git log --oneline v2.64.0..origin/farming/v2.64.0   # 1 commit
git show v2.64.0..origin/farming/v2.64.0            # full diff
```

### What the overlay commit changes

- **Backend** — `cvat/apps/engine/media_extractors.py`: keeps the 4th channel
  intact when building compressed (PNG) chunks for 4-band imagery.
- **cvat-data** — `cvat-data/src/ts/unzip_imgs.worker.ts`: disables
  premultiplied alpha when decoding chunks in the browser, so the 4th channel
  is preserved as raw data and not blended into RGB.
- **UI — Shift+N channel swap** — new SVG `feColorMatrix` filter
  (`channel-swap-filter.tsx`) + Redux state `settings.player.channelSwap24`
  toggled by Shift+N or the “Swap G ↔ 4th channel” switch in the image-setups
  popover. An identity opaque filter is always applied to RGBA frames so they
  do not render translucent. Filter ordering ensures brightness/contrast/
  saturation slide on the post-swap colors. Touches
  `cvat-ui/src/reducers/{index,settings-reducer}.ts`,
  `cvat-ui/src/actions/settings-actions.ts`,
  `cvat-ui/src/components/annotation-page/canvas/views/canvas2d/{channel-swap-filter.tsx (new),canvas-wrapper.tsx,image-setups-content.tsx}`.
- **UI — gamma fix** — `cvat-ui/src/utils/fabric-wrapper/gamma-correction.ts`:
  replaces fabric.js' Gamma filter with a custom LUT-based implementation that
  also gamma-corrects the alpha channel.
- **Backend — upload limits** — `cvat/settings/base.py`: raises upload-size
  limits for large multispectral imagery to match the production server:
  `DATA_UPLOAD_MAX_MEMORY_SIZE` 100 MB → 2 GB, `TUS_MAX_FILE_SIZE` 25 GB →
  50 GB, `ASSET_MAX_SIZE_MB` 10 → 1000, `ASSET_MAX_IMAGE_SIZE` 1920 → 8096,
  `ASSET_MAX_COUNT_PER_GUIDE` 150 → 300.
- **Deployment** —
  - `cvat/nginx.conf`: `client_max_body_size 1G → 32G` for large
    multispectral uploads.
  - `components/serverless/docker-compose.serverless.yml`: exposes the nuclio
    dashboard on `127.0.0.1:8070` for local model deployment.
- **Submodule** — `serverless/onnx/farming_cvat_models` →
  `farming-revolution/farming_cvat_models`.
- **Docs** — this file (`upgrade_cvat_with_farming_changes.md`).

## Workspace-local (gitignored, NOT committed)

Files that every developer needs locally but that must **not** be committed
because they encode per-machine paths and tag overrides:

- `/.env`
  ```env
  CVAT_VERSION=v2.64.0-farming
  ```
- `/docker-compose.override.yml`
  ```yaml
  services:
    cvat_server:
      build:
        context: .
        dockerfile: Dockerfile
        args: { CLAM_AV: 'no', INSTALL_SOURCES: 'no' }
      image: cvat/server:${CVAT_VERSION:-v2.48.1}
      volumes:
        - /mnt/d/workdir/farming/cvat_workdir:/home/django/share:ro
    cvat_ui:
      build:
        context: .
        dockerfile: Dockerfile.ui
      image: cvat/ui:${CVAT_VERSION:-v2.48.1}
    cvat_worker_import:
      volumes:
        - /mnt/d/workdir/farming/cvat_workdir:/home/django/share:ro
    cvat_worker_export:
      volumes:
        - /mnt/d/workdir/farming/cvat_workdir:/home/django/share:ro
    cvat_worker_annotation:
      volumes:
        - /mnt/d/workdir/farming/cvat_workdir:/home/django/share:ro
  ```

These are matched by the existing `.gitignore` entries:

- `/.*env*`             → `.env`
- `/docker-compose.override.yml`

## Clone / initial setup

```bash
git clone --recurse-submodules git@github.com:farming-revolution/cvat.git
cd cvat
git remote add upstream https://github.com/cvat-ai/cvat.git
git fetch upstream --tags

git checkout farming/v2.64.0

# Workspace-local config (NOT committed):
cat > .env <<'EOF'
CVAT_VERSION=v2.64.0-farming
EOF
# Then create docker-compose.override.yml with your local bind mounts
# (see "Workspace-local" section above).
```

If a submodule was added after the initial clone:

```bash
git submodule update --init --recursive
```

## Build & start

The custom images `cvat/server:${CVAT_VERSION}` and `cvat/ui:${CVAT_VERSION}`
must be **built locally** because they contain the farming patches. The
`build:` directives live in `docker-compose.override.yml` (workspace-local),
not in upstream `docker-compose.yml`.

The farming deployment is always composed from the same set of compose files.
Use the variant **with** nuclio for full functionality (auto-annotation),
or **without** nuclio for a lighter stack.

### Required environment variables

`docker-compose.https.yml` requires the following variables to be exported
in the shell **before** running any of the commands below (Let's Encrypt /
Traefik configuration):

```bash
export ACME_EMAIL="daniel.dimarco@farming-revolution.com"
export CVAT_HOST="labeling.farming-revolution.com"
```

If they are unset, the HTTPS stack will fail to start (Traefik cannot request
a certificate without `ACME_EMAIL`, and the router has no host to bind to
without `CVAT_HOST`).

### With nuclio (default)

Build:

```bash
docker-compose \
  -f docker-compose.yml \
  -f docker-compose.override.yml \
  -f components/serverless/docker-compose.serverless.yml \
  -f docker-compose.https.yml \
  build cvat_server cvat_ui
```

Start:

```bash
docker-compose \
  -f docker-compose.yml \
  -f docker-compose.override.yml \
  -f components/serverless/docker-compose.serverless.yml \
  -f docker-compose.https.yml \
  up -d
```

Stop:

```bash
docker-compose \
  -f docker-compose.yml \
  -f docker-compose.override.yml \
  -f components/serverless/docker-compose.serverless.yml \
  -f docker-compose.https.yml \
  down
```

### Without nuclio

Build:

```bash
docker-compose \
  -f docker-compose.yml \
  -f docker-compose.override.yml \
  -f docker-compose.https.yml \
  build cvat_server cvat_ui
```

Start:

```bash
docker-compose \
  -f docker-compose.yml \
  -f docker-compose.override.yml \
  -f docker-compose.https.yml \
  up -d
```

Stop:

```bash
docker-compose \
  -f docker-compose.yml \
  -f docker-compose.override.yml \
  -f docker-compose.https.yml \
  down
```

### Notes

- Run `build` whenever a farming patch is added or modified, then re-run the
  matching `up -d` to recreate the affected containers.
- The resulting image tags are pinned by `CVAT_VERSION` in `.env`
  (e.g. `cvat/server:v2.64.0-farming`, `cvat/ui:v2.64.0-farming`).
- Stop using the **same** set of `-f` files that were used to start, otherwise
  compose will not see all the services.

## Upgrade to a new upstream release

Goal: move the single farming overlay commit from `farming/v<OLD>` onto
upstream tag `v<NEW>` and publish `farming/v<NEW>`.

```bash
# 1. Get the new upstream tag.
git fetch upstream --tags

# 2. Create the new farming branch from the upstream tag.
git checkout -b farming/v<NEW> v<NEW>

# 3. Replay the single farming overlay commit onto the new base.
#    The range v<OLD>..farming/v<OLD> contains exactly one commit.
git cherry-pick v<OLD>..farming/v<OLD>

# 4. Resolve conflicts (most likely in the 4-channel UI/backend files):
#      - cvat/apps/engine/media_extractors.py
#      - cvat-data/src/ts/unzip_imgs.worker.ts
#      - cvat-ui/src/reducers/{index,settings-reducer}.ts
#      - cvat-ui/src/actions/settings-actions.ts
#      - cvat-ui/src/components/annotation-page/canvas/views/canvas2d/*
#      - cvat-ui/src/utils/fabric-wrapper/gamma-correction.ts
#      - cvat/nginx.conf
#      - components/serverless/docker-compose.serverless.yml
#    Then:
git add <files>
git cherry-pick --continue

# 5. (Optional) update this doc in the same commit, then re-squash so
#    farming/v<NEW> still contains exactly ONE overlay commit:
git commit --amend --no-edit

# 6. Push the new branch.
git push -u origin farming/v<NEW>

# 7. Update workspace-local files:
#      .env  -> CVAT_VERSION=v<NEW>-farming
#    Then rebuild (see "Build & start" above).
```

## Tips

- Keep the overlay as **one squashed commit** — every additional commit
  multiplies the work on every upgrade. New farming changes should be
  amended into the overlay commit (`git commit --amend`) and the branch
  force-pushed.
- If upstream changes the structure of a file we patched (e.g. the canvas
  filter chain or the reducers tree), the cherry-pick will conflict; resolve
  by porting the *intent* of the farming overlay, not the literal hunks.
- The submodule pin (`serverless/onnx/farming_cvat_models`) carries forward
  unchanged across upgrades; update it independently when new ONNX models are
  published.
- Workspace-local files (`.env`, `docker-compose.override.yml`) are *never*
  cherry-picked — they live only on each developer's machine.

## Sanity checklist after an upgrade

- [ ] `docker compose up -d --build` succeeds.
- [ ] A 4-channel image task loads, channels are visible.
- [ ] Shift+N toggles the green/4th-channel swap.
- [ ] Brightness / contrast / saturation / gamma sliders behave correctly
      in both swap states.
- [ ] Large (>1G) uploads still succeed (nginx `client_max_body_size`).
- [ ] Nuclio dashboard reachable at http://127.0.0.1:8070.
- [ ] `git submodule status` shows `farming_cvat_models` clean.
