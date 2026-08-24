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

Download the current stable release directly:

| Platform | Installer | Alternative |
| --- | --- | --- |
| macOS Apple Silicon (M1 or newer) | [`hpc-llm-desktop-0.2.1-mac-arm64.dmg`](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases/download/v0.2.1/hpc-llm-desktop-0.2.1-mac-arm64.dmg) | [`hpc-llm-desktop-0.2.1-mac-arm64.zip`](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases/download/v0.2.1/hpc-llm-desktop-0.2.1-mac-arm64.zip) |
| macOS Intel | [`hpc-llm-desktop-0.2.1-mac-x64.dmg`](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases/download/v0.2.1/hpc-llm-desktop-0.2.1-mac-x64.dmg) | [`hpc-llm-desktop-0.2.1-mac-x64.zip`](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases/download/v0.2.1/hpc-llm-desktop-0.2.1-mac-x64.zip) |
| Windows x64 | [`hpc-llm-desktop-0.2.1-windows-x64.exe`](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases/download/v0.2.1/hpc-llm-desktop-0.2.1-windows-x64.exe) | - |
| Linux x86-64 | [`hpc-llm-desktop-0.2.1-linux-x86_64.AppImage`](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases/download/v0.2.1/hpc-llm-desktop-0.2.1-linux-x86_64.AppImage) | - |

Use [`SHA256SUMS.txt`](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases/download/v0.2.1/SHA256SUMS.txt) to verify the downloaded file. The [v0.2.1 release page](https://github.com/rahulsharma-rs/hpc-llm-desktop/releases/tag/v0.2.1) also provides GitHub build-provenance attestations and platform-specific checksums.

The current macOS and Windows files are unsigned and may display an operating-system trust warning. Verify the checksum and provenance before running them. See [Releasing](docs/RELEASING.md) for the signing status and certificate requirements.

On Linux, make the AppImage executable before opening it:

```bash
chmod +x hpc-llm-desktop-0.2.1-linux-x86_64.AppImage
./hpc-llm-desktop-0.2.1-linux-x86_64.AppImage
```

## Connect To An HPC

1. Confirm that the computer is on a network permitted to reach the HPC. When off-site, connect to the institution's VPN before continuing.
2. Start HPC LLM Desktop and open the **Account** view.
3. Enter the HPC **Username**, **Remote host**, and **SSH port** supplied by the HPC administrator. SSH normally uses port `22`, but the institution's documented value is authoritative.
4. Enter the local path to an existing **SSH private key**. To create a dedicated key instead, keep the suggested path and select **Create SSH key**.
5. Select **Save settings**.
6. Select **Check fingerprint**, then compare the displayed fingerprint with the value published by the HPC provider or supplied by its administrator before trusting it.
7. If the public key is not already installed on the HPC, enter the HPC account password and select **Deploy key**. The password is used for this request only, cleared from the form afterward, and never saved.
8. Select **Test SSH login**. A successful test displays the remote username, hostname, and persistent model directory.
9. Select **Create remote folder** to initialize the runtime and model directories in the HPC home space.
10. If a model requires Hugging Face authentication, enter the token and select **Deploy HF token**. The token is transferred to the HPC and is not stored in the local app configuration.
11. Select **Verify llama-server**. If it is unavailable, select **Install llama-server**, then verify it again before installing a model or starting a session.

### Connection Troubleshooting

| Error | What to check |
| --- | --- |
| Connection refused, timed out, or host unreachable | First confirm the remote host and SSH port. If they are correct, the current network probably cannot access the HPC. Switch to an authorized institutional network or connect to the institution's VPN, then retry. |
| Host could not be resolved | Check the hostname for spelling errors. Institutional DNS may also require an authorized network or VPN connection. |
| SSH authentication rejected | The HPC was reached, but it rejected the credentials. Check the username and private-key path, and confirm that the matching public key is installed in the HPC account. |
| Host-key fingerprint changed | Do not replace the saved fingerprint until the HPC provider confirms the new fingerprint. An unexpected change can indicate the wrong host or a security problem. |

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
