// Trace's Palette custom field: the bound
// plot's own palette. The control is a picker and a swatch strip; the field
// (schema/plot.ts) owns the value, the write rule (recolour by slot) and the
// optional-path dot. A pick recolours every curve still at a palette colour by
// itself. The swatch strip is a button that re-picks the current palette,
// which puts every curve back at its palette colour, user-set ones included
// (main's "Apply to all traces"): a native select fires nothing when its
// current option is chosen again.

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
      <button
        type="button"
        className="trace-palette__swatches"
        data-testid="palette-swatches"
        aria-label="Re-pick this palette"
        title="Re-pick this palette: every curve back to its palette color"
        onClick={() => onChange(value)}
        style={{
          display: 'flex',
          gap: 1,
          marginTop: 6,
          width: '100%',
          padding: 0,
          border: 'none',
          background: 'none',
          cursor: 'pointer',
        }}
      >
        {getPalette(value).colors.map((c, i) => (
          <span key={`${c}-${i}`} title={c} style={{ flex: 1, height: 14, backgroundColor: c }} />
        ))}
      </button>
    </div>
  );
}
