// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  arrayText,
  columnsText,
  correlationQueryFor,
  LegendMenu,
  lookbackOf,
  openInChoices,
  quietLegendHover,
  readingNumber,
  traceQueryFor,
} from './contextMenu';

afterEach(() => vi.restoreAllMocks());

describe('openInChoices', () => {
  it('lists every other tool, Correlation as X and as Y', () => {
    expect(openInChoices('waveform', 'A').map((c) => c.label)).toEqual([
      'Trace',
      'Correlation as X',
      'Correlation as Y',
    ]);
    expect(openInChoices('trace', 'A').map((c) => c.label)).toEqual([
      'Waveform',
      'Correlation as X',
      'Correlation as Y',
    ]);
    expect(openInChoices('correlation', 'A').map((c) => c.label)).toEqual(['Trace', 'Waveform']);
  });

  it('opens through the tool-to-tool open with the target’s query', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const [, , asY] = openInChoices('trace', 'TEST:A', { range: '-2h' });
    asY.run();
    expect(open.mock.calls[0][0]).toMatch(/correlation\.html\?y=TEST:A&lookback=2h$/);
  });
});

describe('queries', () => {
  it('build each tool’s grammar, ":" readable', () => {
    expect(traceQueryFor('TEST:A')).toBe('pv=TEST:A&range=-1h');
    expect(correlationQueryFor({ x: 'X:1', y: 'Y:1' }, '30m')).toBe('x=X:1&y=Y:1&lookback=30m');
    expect(lookbackOf('-6h')).toBe('6h');
    expect(lookbackOf('custom')).toBeUndefined();
  });
});

describe('text', () => {
  it('a shot is one value per line; several are tab-separated columns', () => {
    expect(arrayText(new Float64Array([1, 2.5, NaN]))).toBe('1\n2.5\n');
    expect(
      columnsText([
        { name: 'A', values: [1, 2] },
        { name: 'B', values: [3] },
      ])
    ).toBe('A\tB\n1\t3\n2\t');
  });

  it('a reading has four significant digits, an exponent at the extremes', () => {
    expect(readingNumber(1)).toBe('1.000');
    expect(readingNumber(123456)).toBe('1.235e+5');
    expect(readingNumber(0.0001234)).toBe('1.234e-4');
    expect(readingNumber(NaN)).toBe('—');
  });
});

describe('LegendMenu', () => {
  const legend = (name: string, event?: MouseEvent) => ({
    componentType: 'legend',
    value: name,
    event: { event },
  });

  it('a right-click on an entry opens its menu and suppresses the native one', () => {
    const onLegend = vi.fn().mockReturnValue(true);
    const m = new LegendMenu(onLegend);
    const e = new MouseEvent('contextmenu', { cancelable: true });
    m.events.contextmenu(legend('TEST:A', e));
    expect(onLegend).toHaveBeenCalledWith('TEST:A', e);
    expect(e.defaultPrevented).toBe(true);
    m.events.contextmenu({ componentType: 'series', value: 'x' });
    expect(onLegend).toHaveBeenCalledTimes(1);
  });

  it('a left-click over an entry toggles nothing; elsewhere it passes', () => {
    const m = new LegendMenu(() => false);
    const click = () => {
      const e = new MouseEvent('click');
      const stop = vi.spyOn(e, 'stopPropagation');
      m.blockClick(e);
      return stop.mock.calls.length;
    };
    expect(click()).toBe(0);
    m.events.mouseover(legend('TEST:A'));
    expect(click()).toBe(1);
    m.events.mouseout(legend('TEST:A'));
    expect(click()).toBe(0);
  });

  it('series do not highlight from the legend', () => {
    expect(quietLegendHover([{ id: 'a' }])).toEqual([{ id: 'a', legendHoverLink: false }]);
  });
});
