// @vitest-environment jsdom
//
// The formula help text's <code> examples ({x1}, {x1} + {x2}, {var}) once
// hard-coded #78a9ff, the dark theme's link colour, which is about 2.4:1 on
// the light theme's white panel. They must follow the theme's link token: the
// `prop-code-var` class, whose rule names `--cds-link-primary`, and no inline
// colour of their own.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { FormulaEditorControl } from './formulaEditor';
import { WithCanopy } from '../../../test/canopy';

afterEach(cleanup);

// The stylesheet as written (vitest does not process CSS); tests run from the repo root.
const appCss = readFileSync('src/App.css', 'utf8');

/** The declarations of `selector`'s rule in `css`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} rule`);
  return css.slice(start, css.indexOf('}', start));
}

describe('formula help text', () => {
  it('colours every code example with the theme link token', () => {
    // An empty expression shows every help example, including the "Add a
    // {var}" hint, and sends no validation request.
    render(
      <FormulaEditorControl
        value={{ expression: '', bindings: {} }}
        bindable={[]}
        resolvedBindings={{}}
        onChange={() => {}}
      />,
      { wrapper: WithCanopy }
    );
    const examples = ['{x1}', '{x1} + {x2}', '{var}'].map((text) =>
      screen.getByText(text, { selector: 'code' })
    );
    expect(examples.map((el) => [el.className, el.style.color])).toEqual(
      examples.map(() => ['prop-code-var', ''])
    );
    const body = ruleBody(appCss, '.prop-code-var');
    expect(body).toMatch(/color:[^;]*var\(--cds-link-primary\)/);
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
