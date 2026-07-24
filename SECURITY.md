# Security Policy

## Supported Versions

Only the latest version published to npm receives security fixes. Releases are
automated: every merge to `main` publishes a new patch version, so upgrading to
the latest release always includes all shipped fixes.

| Version | Supported |
| --- | --- |
| Latest npm release | ✅ |
| Older releases | ❌ |

## Reporting a Vulnerability

Please report security issues privately so a fix can be released before the
details are public:

- Preferred: open a private report through
  GitHub Security Advisories for this repository after it is published.
- Before publication, contact the repository owner privately with a description,
  reproduction steps, and the affected version.

Please do not open a public issue for suspected vulnerabilities.

## What to expect

- We will acknowledge your report within 5 business days.
- We will assess impact, work on a fix, and keep you informed of progress.
- Once a fix is published to npm, we will credit you in the release notes if
  you would like.

## Scope notes

This plugin runs inside OpenCode with the permissions of the OpenCode session
that loads it. Reports about the plugin weakening a user-facing OpenCode
boundary (for example mode isolation, permission prompts, or autonomous
continuation limits) are in scope, even when the underlying capability is
provided by OpenCode itself.
