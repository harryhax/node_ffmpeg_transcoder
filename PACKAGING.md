# Packaging (pkg)

This project can be packaged into standalone executables so users do not need Node.js installed.

## GitHub Actions Release (Recommended)

The easiest way to create a release is via GitHub Actions:

1. Update `version` in `package.json` to match your next release (e.g., `1.0.1`)
2. Commit and push the version bump
3. Create and push a git tag:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
4. GitHub Actions automatically builds and publishes versioned zips for:
   - macOS (Intel + Apple Silicon)
   - Linux x64
   - Windows x64

The workflow validates that the git tag matches `package.json` version before publishing.

You can also trigger a test build manually from the GitHub Actions tab without creating a release.

## Runtime Notes

- `ffmpeg` and `ffprobe` are still required on the user machine.
- The app's `views/`, `public/`, and `README.md` are included in the packaged executable.
- Users run the generated binary directly; no Node.js install is required.
