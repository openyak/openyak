# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenYak, please report it responsibly.

**Email:** [support@waxis.org](mailto:support@waxis.org)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

**Do not** open a public GitHub issue for security vulnerabilities.

## Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 7 days
- **Fix or mitigation:** depends on severity, typically within 30 days

## How OpenYak Handles Your Data

OpenYak is designed as a local-first desktop agent:

- **No OpenYak account is required.** The app does not depend on an OpenYak login, billing profile, recharge flow, or hosted workspace backend.
- **Files, conversations, memory, generated artifacts, and workflow state** are stored on your device.
- **Local model usage** through Ollama, Rapid-MLX, or another local endpoint keeps model requests on your machine.
- **Cloud model usage** is optional and sends prompt context directly from your desktop to the model provider you configured. OpenYak does not proxy, log, or store these requests.
- **No telemetry, no analytics, no tracking.** OpenYak does not collect usage data.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Previous minor | Best effort |
| Older | ❌ |

We recommend always using the [latest release](https://github.com/openyak/desktop/releases/latest).

## Scope

The following are in scope for security reports:

- Local file access vulnerabilities (unauthorized read/write)
- Data leakage to unintended third parties
- Code execution vulnerabilities in tool/bash execution
- MCP connector security issues
- Authentication/authorization bypass in remote access feature

Out of scope:

- Vulnerabilities in third-party model provider APIs
- Social engineering attacks
- Denial of service against local application
