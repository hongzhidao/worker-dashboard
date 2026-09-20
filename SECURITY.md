# Security Policy

## Supported Versions

Security fixes are provided for the latest released version. Please include
the Dashboard version and the Worker version when reporting an issue.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately
to the repository maintainers through the security contact configured on the
repository, including:

- affected version and deployment mode;
- reproduction steps or a minimal proof of concept;
- impact and any known mitigations.

Please do not include real passwords, control socket data, environment values,
or production configuration snapshots in a report.

## Deployment Guidance

The built-in HTTP server is intended to run behind a trusted network boundary.
For remote access, use HTTPS at a reverse proxy, restrict access with a VPN or
firewall, configure `--allow-host`, and keep the private state directory out of
the web root. The state directory contains authentication data and configuration
history and must not be committed to source control.
