# Publish Checklist

Releases are published by `.github/workflows/publish.yml` using **npm OIDC trusted publishing**. Pushing a `v*` tag triggers the workflow, which typechecks, tests, publishes to npm with provenance, and creates a matching GitHub Release from the CHANGELOG section.

## One-Time Setup (npm trusted publisher)

Required once per package before the workflow can publish. The token-based path is intentionally not used.

1. Visit https://www.npmjs.com/package/pi-multiloop/access (must be signed in as a maintainer).
2. Under **Publishing access** → **Trusted publishers**, click **Add trusted publisher**.
3. Choose **GitHub Actions** and enter:
   - Organization or user: `lhl`
   - Repository: `pi-multiloop`
   - Workflow filename: `publish.yml`
   - Environment name: *(leave blank unless you add a GitHub Environment for the publish job)*
4. Save.

No `NPM_TOKEN` secret is needed. The workflow requests an OIDC token from GitHub at publish time, and npm verifies it matches the trusted-publisher record.

## Before You Start

- [ ] Decide on version bump (patch/minor/major).
- [ ] Working tree is clean on `main`.
- [ ] Previous version has a git tag and GitHub Release.

## Local Verify (fast feedback before pushing)

- [ ] `npm install`
- [ ] `npx tsc --noEmit` passes.
- [ ] `npx vitest run` passes.
- [ ] `pi install .` loads without errors (optional smoke test).

The publish workflow re-runs both gates in CI before publishing, so this is just a fast local pre-flight.

## Review

- [ ] README accuracy (commands, features, examples).
- [ ] `CHANGELOG.md` has a section for the new version (`## X.Y.Z - YYYY-MM-DD`) — the workflow extracts this verbatim as the GitHub Release body, so write it for humans.
- [ ] `docs/PLAN.md` updated if scope or north stars changed.
- [ ] `AGENTS.md` updated if file layout or conventions changed.
- [ ] Mode descriptions in `extensions/pi-multiloop/modes.ts` updated if modes changed.

## Cut the Release

```bash
# Bump version
# (edit package.json by hand, or `npm version X.Y.Z --no-git-tag-version`)
# Update CHANGELOG.md with a "## X.Y.Z - YYYY-MM-DD" section

git add package.json CHANGELOG.md
git commit -m "chore: bump version to vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

The tag push triggers `.github/workflows/publish.yml`. Watch it at https://github.com/lhl/pi-multiloop/actions.

## What the Workflow Does

1. Checkout, install Node 22 + latest npm, install deps.
2. `npx tsc --noEmit` and `npx vitest run`.
3. Refuse to publish if the tag (`v0.3.2`) does not match `package.json` (`0.3.2`).
4. `npm publish --provenance --access public` (authenticated via OIDC).
5. Extract the matching section from `CHANGELOG.md` and `gh release create` with it.

## Manual Re-Run

If a tag is already pushed but the workflow failed midway, re-run it from the Actions tab. Pre-existing-tag re-runs are safe; npm will reject a duplicate version (the workflow stops, no harm done).

A manual `workflow_dispatch` run skips the tag-vs-version guard and the GitHub Release step, so it is mainly useful for republishing the version currently in `package.json` after a transient infra failure.

## After Publishing

- [ ] `npm info pi-multiloop` shows the new version under `dist-tags.latest`.
- [ ] GitHub Releases page shows the new release: https://github.com/lhl/pi-multiloop/releases
- [ ] Test install: `pi install -e npm:pi-multiloop@X.Y.Z` (or just `npm:pi-multiloop` for the new `latest`).

## Why OIDC

- No long-lived `NPM_TOKEN` secret to rotate, lose, or leak.
- Every publish carries SLSA build provenance (`--provenance`) so consumers can verify it came from this repo's CI.
- Maintainer access on npm is tied to the GitHub repo + workflow pair, so revoking publish rights is a one-click registry action.

## Future Considerations

- Add a separate CI workflow (typecheck + test on PRs) so the publish workflow is purely a release path.
- Pin a GitHub Environment for the publish job (e.g., `npm-publish`) to require manual approval before the publish step runs.
