# Publish Checklist

Steps to publish a new version of pi-multiloop.

## Before You Start

- [ ] Decide on version bump (patch/minor/major)
- [ ] Make sure all changes are committed on main
- [ ] Check that the previous version has a git tag and GitHub Release

## Verify

- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes
- [ ] `pi install file:.` loads without errors
- [ ] `/multiloop status` responds correctly

## Review

- [ ] Review README for accuracy (commands, features, examples all match current behavior)
- [ ] Update README if any user-facing behavior changed
- [ ] Update CHANGELOG with new version section and summary of changes
- [ ] Update `docs/PLAN.md` if scope or north stars changed
- [ ] Update `CLAUDE.md` if file layout or conventions changed
- [ ] Update mode descriptions in `extensions/pi-multiloop/modes.ts` if modes changed

## Commit and Tag

- [ ] Commit version bump: `chore: bump version to vX.Y.Z`
- [ ] Tag the commit: `git tag vX.Y.Z`
- [ ] Push commit and tag: `git push && git push --tags`

## Publish

- [ ] `npm publish` (or `npm publish --dry-run` first to check)
- [ ] Create GitHub Release:
  ```bash
  gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
  <paste changelog section here>
  EOF
  )"
  ```

## After Publishing

- [ ] Verify on npm: `npm info pi-multiloop`
- [ ] Test install from registry: `pi install npm:pi-multiloop`

## Future Considerations

- Trusted publishing via GitHub Actions (see textguard/shisad for examples)
- CI workflow for automated test gates before publish
