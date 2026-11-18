// The colour field's control, ported from RightPanel's
// ColorSwatch. The browser's own colour input cannot be restyled, so it sits
// invisible behind a swatch button that shows the current colour and opens the
// native picker. The swatch is the one tab stop; the input shares its box so
// the picker opens at the swatch. Chrome tokens only: the colour shown is the
// field's value, never a literal of ours.
//
// The native input takes only `#rrggbb`. A value in another form (a theme
// variable such as a drawing's ink, `var(--cds-text-primary)`) is given to
// the swatch as is, and to the input as the colour the swatch shows,
// resolved when the picker opens, so the picker starts at that colour.

import { useRef, useState } from 'react';

const HEX = /^#[0-9a-f]{6}$/i;

/** A computed `rgb()` / `rgba()` colour as `#rrggbb`; null when it is not one. */
function rgbToHex(css: string): string | null {
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(css.trim());
  if (!m) return HEX.test(css.trim()) ? css.trim().toLowerCase() : null;
  const hex = m
    .slice(1, 4)
    .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}

export interface ColourSwatchProps {
  value: string;
  /** The swatch's accessible name. */
  label: string;
  onChange(colour: string): void;
  disabled?: boolean;
  /** The id of the field's note (disabled reason or help). */
  describedBy?: string;
  /** The Properties hook (`trace-color-swatch`) or a header field's testid. */
  testId?: string;
  /** The small Outline row form. */
  small?: boolean;
}

export function ColourSwatch({
  value,
  label,
  onChange,
  disabled,
  describedBy,
  testId,
  small,
}: ColourSwatchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const isHex = HEX.test(value);
  // The colour a non-hex value shows, resolved at the last opening.
  const [shown, setShown] = useState('');
  const openPicker = () => {
    const input = inputRef.current;
    if (!input) return;
    const swatch = swatchRef.current;
    if (!isHex && swatch) {
      const view = swatch.ownerDocument.defaultView;
      const hex = view ? rgbToHex(view.getComputedStyle(swatch).backgroundColor) : null;
      if (hex !== null) {
        input.value = hex;
        setShown(hex);
      }
    }
    if (typeof input.showPicker === 'function') {
      try {
        input.showPicker();
        return;
      } catch {
        // No user activation or a cross-origin frame: fall through to click().
      }
    }
    input.click();
  };
  return (
    <span
      className={`wb-swatch-wrap trace-color-swatch-wrap${small ? ' wb-swatch-wrap--small' : ''}`}
    >
      <input
        ref={inputRef}
        type="color"
        value={isHex ? value : shown}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          margin: 0,
          padding: 0,
          border: 0,
          opacity: 0,
          pointerEvents: 'none',
        }}
      />
      <button
        ref={swatchRef}
        type="button"
        className="wb-swatch trace-color-swatch"
        data-testid={testId}
        aria-label={label}
        aria-describedby={describedBy}
        title={label}
        disabled={disabled}
        style={{ backgroundColor: value }}
        onClick={openPicker}
      />
    </span>
  );
}
