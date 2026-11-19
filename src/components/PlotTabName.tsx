// A plot tab's name, renamed in place: double-click it to edit, Enter or a
// click away keeps the new name, Escape keeps the old one. A name left empty
// (or only spaces) keeps the old one too. The same title is the Display
// section's Title field, which stays the way to rename from the keyboard.
import { useState, type KeyboardEvent } from 'react';

/** The longest name a tab takes; the Title field has no limit of its own. */
export const PLOT_NAME_MAX = 80;

export interface PlotTabNameProps {
  title: string;
  /** Without it the name is plain text. */
  onRename?: (title: string) => void;
}

export function PlotTabName({ title, onRename }: PlotTabNameProps) {
  const [draft, setDraft] = useState<string | null>(null);

  if (!onRename) return <span>{title}</span>;

  if (draft === null) {
    return (
      <span
        className="plot-tab__name"
        title="Double-click to rename"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(title);
        }}
      >
        {title}
      </span>
    );
  }

  const commit = () => {
    const next = draft.trim();
    setDraft(null);
    if (next !== '' && next !== title) onRename(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === 'Escape') {
      // Consumed here, so it doesn't also leave fullscreen or disarm a tool.
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
    }
  };

  return (
    <input
      className="plot-tab__rename"
      aria-label="Plot name"
      value={draft}
      maxLength={PLOT_NAME_MAX}
      size={Math.max(6, Math.min(draft.length + 1, 24))}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
