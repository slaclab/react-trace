// The colour field's control, ported from RightPanel's
// ColorSwatch. The browser's own colour input cannot be restyled, so it sits
// invisible behind a swatch button that shows the current colour and opens the
// native picker. The swatch is the one tab stop; the input shares its box so
// the picker opens at the swatch. Chrome tokens only: the colour shown is the
// field's value, never a literal of ours.

import { useRef } from 'react';

export interface ColourSwatchProps {
  value: string;
  /** The swatch's accessible name. */
  label: string;
  onChange(colour: string): void;
  disabled?: boolean;
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
  testId,
  small,
}: ColourSwatchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    const input = inputRef.current;
    if (!input) return;
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
        value={value}
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
        type="button"
        className="wb-swatch trace-color-swatch"
        data-testid={testId}
        aria-label={label}
        title={label}
        disabled={disabled}
        style={{ backgroundColor: value }}
        onClick={openPicker}
      />
    </span>
  );
}
