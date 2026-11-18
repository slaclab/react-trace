# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Don't open a public issue,
pull request or discussion for them.

Use GitHub's private vulnerability reporting: open the repository's
[Security tab](https://github.com/slaclab/react-trace/security) and choose
**Report a vulnerability**. Only the maintainers can see the report.

A useful report says:

- which commit or image tag you used;
- the steps to reproduce it and what you expected to happen;
- the impact as you understand it.

The maintainers will acknowledge the report, work with you on a fix and agree a
disclosure date with you. Tell us if you want to be credited.

## Supported versions

Trace is pre-1.0 and has no releases. Security fixes are made on `main` and
ship in the next image (`ghcr.io/slaclab/react-trace`, tag `latest` or `sha-`
followed by the commit's short SHA). Use the latest one.

## Scope

This repository holds the Trace browser app and the nginx image that serves it.
The image's reverse proxy adds the deployment's Canopy API key to requests, so
the key never reaches the browser; a way to read that key, or to make the proxy
send requests it shouldn't, is in scope.

Report a vulnerability in the Canopy server to
[slaclab/canopy](https://github.com/slaclab/canopy/security), and one in another
dependency to that project. Tell us too if Trace's usage of it makes the impact
worse.
