# Security Policy

## Reporting A Vulnerability

Please report vulnerabilities privately through the repository's **Security** tab by opening a private vulnerability report. Do not include credentials, SSH keys, HPC account details, model access tokens, or exploit details in a public issue.

## Sensitive Data

HPC passwords are used only for first-time SSH key deployment and are not persisted. Hugging Face tokens are sent directly to the configured HPC account and are not stored locally. Never commit local configuration files, environment files, signing certificates, SSH keys, or CI secret values.

## Supported Versions

Security fixes are applied to the latest published release.
