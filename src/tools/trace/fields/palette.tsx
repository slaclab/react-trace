// Trace's Palette custom field: the bound
// plot's own palette. The control is a picker and a swatch strip; the field
// (schema/plot.ts) owns the value, the write rule (recolour by slot) and the
// optional-path dot. There is no "Apply to …" action: a pick recolours every
// curve still at a palette colour by itself.

import type { ReactNode } from 'react';
import { Select, SelectItem } from '@carbon/react';
import { PALETTES, getPalette } from '../../../palettes';

export interface PaletteControlProps {
  id?: string;
  /** The bound plot's palette id. */
  value: string;
  onChange(paletteId: string): void;
}

export function PaletteControl({ id, value, onChange }: PaletteControlProps): ReactNode {
  return (
    <div className="trace-palette">
      <Select
        id={id ?? 'plot-palette'}
        labelText="Palette"
        hideLabel
        size="sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {PALETTES.map((p) => (
          <SelectItem key={p.id} value={p.id} text={p.label} />
        ))}
      </Select>
      <div
        className="trace-palette__swatches"
        data-testid="palette-swatches"
        style={{ display: 'flex', gap: 1, marginTop: 6 }}
      >
        {getPalette(value).colors.map((c, i) => (
          <div key={`${c}-${i}`} title={c} style={{ flex: 1, height: 14, backgroundColor: c }} />
        ))}
      </div>
    </div>
  );
}
