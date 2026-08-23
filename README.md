# HPC LLM Desktop

[![Build installers](https://github.com/rahulsharma-rs/hpc-llm-desktop/actions/workflows/build-installers.yml/badge.svg)](https://github.com/rahulsharma-rs/hpc-llm-desktop/actions/workflows/build-installers.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

HPC LLM Desktop is a standalone Electron and browser client for connecting an HPC account, installing persistent GGUF models, launching Slurm-backed llama-server sessions, opening SSH tunnels, and configuring an OpenCode-compatible endpoint.

The desktop and browser surfaces share one authenticated local service. The service binds only to `127.0.0.1`, uses a random token for every launch, and rejects unauthenticated API requests. The application is implemented entirely in Node.js and does not require Python.

## Requirements

- An OpenSSH client providing `ssh`, `ssh-keygen`, and `ssh-keyscan`.
- Access to a supported Slurm HPC cluster. The included partition and module presets currently target UAB Cheaha.
- Node.js 22 or later only when running from source.

## Download

Installers for macOS ARM64/x64, Windows x64, and Linux x64 are published on the [GitHub Releases](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases) page. Each release includes SHA-256 checksums and GitHub build-provenance attestations.

## Run From Source

```bash
npm install
npm start
```

On macOS, `run_desktop_app.command` provides a Finder-friendly launcher. Starting the desktop app also opens the same authenticated interface in the system browser.

To run only the browser interface:

```bash
npm run browser
```

## Test

```bash
npm run check
```

The test suite covers configuration, model and partition catalog data, SSH/Slurm parsing, session preflight, service behavior, and local API routes.

## Package

```bash
npm run package
npm run dist
```

Artifacts are written to `dist/`. The configured distribution targets are macOS DMG/ZIP, Windows NSIS, and Linux AppImage. Build and sign public installers on their target operating systems; macOS releases require signing and notarization, and Windows releases should be code-signed.

The GitHub Actions workflow builds all supported platforms. See [Releasing](docs/RELEASING.md) for certificate-secret names, signing behavior, tagging, and provenance verification.

## Account And Storage

Each user supplies their HPC hostname, SSH port, username, and private key on the Account screen. The app can create a dedicated Ed25519 key and deploy its public key using the user's password. Passwords are used only for that request and are never persisted. Hugging Face tokens are transferred directly to the user's HPC runtime directory and are not stored locally.

After connecting, the app discovers the account's actual `$HOME`. Models remain in the established persistent `$HOME/cheaha_llm_client/gguf_models` directory for compatibility; new runtime files default to `$HOME/.hpc-llm/runtime`. Downloads validate available home storage and final file size, retry transient failures, and preserve `.part` files so interrupted downloads can resume.

Local settings use the platform configuration directory:

- macOS: `~/Library/Application Support/hpc-llm-desktop/config.json`
- Windows: `%APPDATA%\\hpc-llm-desktop\\config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/hpc-llm-desktop/config.json`

Existing `cheaha-llm-electron` settings are migrated automatically on first launch after upgrading.

## Slurm Safety

The launch form keeps documented partition limits separate from live `sinfo` state. Selecting a partition applies a scheduler-safe resource preset, while **Use recommended defaults** restores model-specific partition, runtime, resources, and context values.

**Test configuration** validates the model file, matching llama-server binary, and exact generated Slurm script with `sbatch --test-only`; it does not create a queued job. **Start LLM session** repeats that preflight before submitting the real job so invalid partition, time, CPU, memory, and GPU requests return actionable errors.

## Security And License

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). HPC LLM Desktop is available under the [MIT License](LICENSE).
