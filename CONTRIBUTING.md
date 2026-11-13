# Contributing

## Local Setup

Requires [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/installation).

```bash
git clone https://github.com/slaclab/react-trace
cd react-trace
pnpm install
pnpm dev
```

`pnpm install` also sets up the pre-commit hook. To see data, the dev server
needs a Canopy backend; [README.md](README.md#local-dev) shows how to run one
and point the dev proxy at it.

## Running Tests

```bash
pnpm test
```

## Code Style

This project uses [ESLint](https://eslint.org/) for linting and [Prettier](https://prettier.io/) for formatting. The pre-commit hook runs both on your staged files.

To run them manually, as CI does:

```bash
pnpm lint
pnpm format:check
```

`pnpm build` type-checks the app and the Vite config (`tsc -b`) before bundling; run it before opening a pull request.

## Documentation

The user guide in `docs/` is built with [Zensical](https://zensical.org/), which needs [uv](https://docs.astral.sh/uv/):

```bash
uv run zensical serve
```

## Submitting Changes

1. Create a branch off `main` using the format `<username>/<description>` or `<username>/#<issue-number>-<description>`
2. Make your changes and ensure tests pass
3. Open a pull request using the provided template

### From a fork

If you don't have write access to this repository, fork it, clone your fork and
follow the setup above. Branch off `main` in your fork; the branch name format
above is only a convention for people who push here, so any descriptive name
works. Open the pull request against `slaclab/react-trace:main`.

- For anything larger than a small fix, open an issue first so we can agree on
  the approach before you spend time on it.
- A maintainer has to approve the GitHub Actions run on a pull request from a
  fork before it starts.
- Pull requests need an approving review before they can be merged.

## Reporting Security Issues

Don't report vulnerabilities in public issues or pull requests. See
[SECURITY.md](SECURITY.md).

## License

Trace is distributed under the terms in [LICENSE.md](LICENSE.md). By
contributing, you accept that the last paragraph of that file, which licenses
enhancements that you make available, applies to your contribution.
