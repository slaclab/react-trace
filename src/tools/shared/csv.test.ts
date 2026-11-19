import { describe, expect, it } from 'vitest';
import { csvField } from './csv';

describe('csvField', () => {
  it('leaves a plain cell alone', () => {
    expect(csvField('SIM:Y1')).toBe('SIM:Y1');
    expect(csvField('Δ SIM:WF:X')).toBe('Δ SIM:WF:X');
  });

  it('quotes a cell holding a quote, comma or line break', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
  });

  it('prefixes a cell a spreadsheet would read as a formula', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+SIM:Y1')).toBe("'+SIM:Y1");
    expect(csvField('-2')).toBe("'-2");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('\tSIM')).toBe("'\tSIM");
  });

  it('neutralises before quoting', () => {
    expect(csvField('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
  });
});
