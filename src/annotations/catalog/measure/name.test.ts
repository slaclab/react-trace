// A falling measurement's card name prints Δ with the minus sign the readout
// uses ("Measure Δ−21.49 mA / 4 s"), never a hyphen.
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG } from '../index';
import { TIME_X_AXIS } from '../xAxis';
import { objNameIn, type Annotation } from '../../model';

const measure = (v0: number, v1: number): Annotation => ({
  id: 'm',
  kind: 'measure',
  points: [
    { t: 0, v: v0 },
    { t: 4000, v: v1 },
  ],
  axisId: 'a',
  color: '#336699',
  width: 1,
  text: '',
});

const axes = [{ id: 'a', name: 'Current', units: 'mA' }];

describe('the Measure card name', () => {
  it('prints a fall with the minus sign', () => {
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, measure(30, 8.51), axes)).toBe(
      'Measure Δ−21.49 mA / 4 s'
    );
  });

  it('prints a rise unchanged', () => {
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, measure(8.51, 30), axes)).toBe(
      'Measure Δ21.49 mA / 4 s'
    );
  });
});
