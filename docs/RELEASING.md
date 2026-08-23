# Releasing HPC LLM Desktop

GitHub Actions builds macOS ARM64/x64, Windows x64, and Linux x64 installers. Every non-pull-request build receives a GitHub artifact provenance attestation and SHA-256 checksums.

## Unsigned Builds

Builds run without certificate files in the repository. Without platform credentials, macOS and Windows installers are usable for testing but display operating-system trust warnings. GitHub provenance attests where the files were built; it does not replace Apple Gatekeeper or Windows Authenticode signing.

## Signing Secrets

Configure these values under **Settings > Secrets and variables > Actions**. Never commit their values.

### macOS

- `MAC_CSC_LINK`: Base64-encoded Developer ID Application `.p12`.
- `MAC_CSC_KEY_PASSWORD`: Password for the certificate archive.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password.
- `APPLE_TEAM_ID`: Apple Developer team identifier.

When all values are present, electron-builder signs and notarizes the app and staples the notarization ticket.

### Windows

- `WIN_CSC_LINK`: Base64-encoded Authenticode `.pfx`/`.p12` certificate.
- `WIN_CSC_KEY_PASSWORD`: Password for the certificate archive.

When both values are present, electron-builder signs the executable and NSIS installer.

Linux AppImage releases do not require an OS vendor certificate. Their integrity is covered by SHA-256 checksums and GitHub provenance attestations.

## Publish A Release

Update the version in `package.json` and `package-lock.json`, commit it, then create and push a matching tag:

```bash
git tag v0.2.1
git push origin v0.2.1
```

The workflow builds all installers and creates the GitHub release. Verify a downloaded artifact with:

```bash
gh attestation verify "hpc-llm-desktop-0.2.1-mac-arm64.dmg" -R rahulsharma-rs/hpc-llm-desktop
```
