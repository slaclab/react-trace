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

### Chrome literals: colors and fonts come from the theme tokens

Trace's own interface (its "chrome") takes its colors and fonts from the
`--canopy-*` contract variables, so a host application can restyle it from one
stylesheet. A color or font written as a literal in the chrome escapes that
contract. `scripts/check-chrome-literals.mjs` enforces this. `pnpm test` runs it
first, and you can run it alone:

```bash
node scripts/check-chrome-literals.mjs                 # every guarded file
node scripts/check-chrome-literals.mjs src/App.css     # only the named files
```

**What it checks.** Each guarded file is checked for:

- a color literal: a hex color (`#fff`, `#0f62fe80`), a color function
  (`rgb()`, `rgba()`, `hsl()`, `hsla()`, and `hwb()`, `lab()`, `lch()`,
  `oklab()`, `oklch()`, `color(srgb ...)`; one that wraps a `var()` is fine),
  or a CSS color name (all 148, such as `red` or `rebeccapurple`);
- a `font` or `font-family` that is not `inherit` or a `--canopy-font-*`
  variable;
- in the workbench only (`src/workbench/`), a `font-size` that is not `inherit`
  or a `--canopy-text-*` variable.

Use `var(--canopy-...)` (colors, text sizes, fonts) instead.

**Where it looks.** The guarded files are the list in `DEFAULT_FILES` plus
every file under `GUARDED_TREES` in the script: all production modules and
stylesheets of `src/workbench`, `src/plot` and `src/annotations`, and the
stylesheets of `src/tools/waveform` and `src/statistics`. Tests and
`__fixtures__` hold sample data and are not guarded. A new file in a guarded
tree is guarded without editing the script.

**How a file is read.** The guard reads each file the way its syntax works, so
ordinary code is not mistaken for a style:

- In a `.css` file only declarations are read: a selector such as `#feed {`, a
  `url(#id)` and quoted text are not colors, and a color name counts only in
  the value of a color property (`color`, `background`, `border`, `fill`,
  custom properties and so on), so `white-space` and `var(--x-red)` pass.
- In a `.ts`/`.tsx` file only string literals, template literals and style
  objects (`style={{...}}`, `style: {...}`, a `CSSProperties` value) are read.
  Types (`font: string`), identifiers, JSX text, comments, object keys and
  import paths are not. A string's context counts too: `href="#a11"`, a
  selector passed to `querySelector` or `closest`, and a message passed to
  `new Error()` or `console.*` are not styles, and a color name counts only
  under a color key (`color`, `backgroundColor`, `fill`, `stroke`, `border...`)
  or a color attribute (`fill="red"`), so `<Tag type="red">` passes.
- Any other file is read line by line as raw text, with hex colors, color
  functions and fonts checked but not color names.

**How to exempt a line.** Put a comment on the line before it:

```css
/* canopy-allow-literal: document background */
background: #161616;
```

In TypeScript use `// canopy-allow-literal: <reason>`, or
`{/* canopy-allow-literal: <reason> */}` in JSX. The reason must be one of the
accepted reasons below, and every exemption must also be counted in
`scripts/chrome-literals.allow` (`<file>: <reason>: <count>`, one line per file
and reason), which the full run checks in both directions, so an exemption is
never added or dropped silently. Run the guard on its own to see the exempt
lines it found.

**Accepted reasons.**

| Reason                | Use it for                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `document background` | the page background behind the app, which no host variable replaces                         |
| `@media print`        | a print stylesheet, where the theme variables do not apply                                  |
| `widget prop default` | the default of a widget prop that takes a color, before a host sets it                      |
| `Carbon danger pair`  | the text color paired with a Carbon danger background token, which has no contract variable |
| `not a style literal` | a string the guard reads as a color or font that is not one (an id, a label, sample data)   |

A line that is not really a style is better rewritten so that the guard no
longer sees it than exempted. Use `not a style literal` only when it can't be.

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
