// Drawing rail: a vertical toolbar on the plot area's left
// edge, inside the plot mount, so every site (tab, grid, fullscreen, detached)
// gets it through SinglePlot.
//
// The tool toggles come from the plot's catalog (icon, long label, key, rail
// group). They stand
// in their rail groups (lines, areas, marks), a separator between groups.
//
// One toggle per drawing tool (pressed = armed for this plot; pressing the
// armed tool again disarms back to the cursor), then the strip toggles of the
// shared registry (`plotToggles.ts`), the same in every plot tool, in their
// own groups: magnet and keep-drawing, the data tooltip and drag mode, then
// hide-all.
//
// Every button has a fast tooltip: its name, and its key when it has one
// (Alt+H V L R B N M for the built-ins), shown beside the rail
// {@link TIP_DELAY} ms after the pointer or focus arrives, and at once while
// moving along the rail from one tooltip to the next. The browser's own
// `title` waits a second or more, so the buttons carry none.
//
// The rail is plot chrome: its root carries `data-drawing-rail`, which
// `isPlotChrome` matches, and it stops native `pointerdown`/`mousedown`
// propagation itself, so a press here never reaches the wrapper's Y-band drag
// or interior pan. React's synthetic stopPropagation would be
// too late (the wrapper's listeners are native). Because the press never
// reaches the wrapper, its focus-on-press never runs either: the rail focuses
// the plot root itself (`focusRoot`, with preventScroll) so the keymap is live
// right after arming.
//
// No colour literals here (src/annotations is literal-guarded): canopy/Carbon
// variables only.
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from 'react';
import type { Catalog } from './catalog/types';
import { stopNativeEvents } from '../plot/geometry';
import { PLOT_TOGGLES, type PlotView } from '../plot/plotToggles';
import type { AnnotationToolPrefs } from './tools';

export interface DrawingRailProps {
  /** This plot's drawing-tool prefs. */
  prefs: AnnotationToolPrefs;
  /** Patches this plot's prefs; absent = the tool and prefs toggles are disabled. */
  onPrefs?: (patch: Partial<AnnotationToolPrefs>) => void;
  /** This plot's drawings are hidden (hide-all). */
  hidden?: boolean;
  /** Writes hide-all for this plot (TraceUi.setAnnotationsHidden); absent = no hide toggle. */
  onHiddenChange?: (on: boolean) => void;
  /** The plot's view settings (tooltip, drag mode); absent = no view toggles. */
  view?: PlotView;
  /** Patches the plot's view settings; absent = no view toggles. */
  onView?: (patch: Partial<PlotView>) => void;
  /** Focuses the plot root (`focus({ preventScroll: true })`). */
  focusRoot?: () => void;
  /** The tools the plot offers; absent = the built-in tools. */
  catalog: Catalog;
}

type Icon = ComponentType<{ size?: number }>;

interface ToolSpec {
  kind: string;
  icon: Icon;
  /** The tool's rail group (its kind when it names none). */
  group: string;
  /** The tool's long label. */
  label: string;
  /** The Alt+<letter> that arms it, e.g. `Alt+H`; '' when it has no key. */
  shortcut: string;
}

/** The rail's tool toggles over `catalog`: grouped, groups in first-seen order, catalog order within. */
function railToolsIn(catalog: Catalog): readonly ToolSpec[] {
  const tools = catalog.tools.map((t) => ({
    kind: t.kind,
    icon: t.icon,
    group: t.railGroup ?? t.kind,
    label: t.label.long,
    shortcut: t.key ? `Alt+${t.key.toUpperCase()}` : '',
  }));
  const order = [...new Set(tools.map((t) => t.group))];
  return order.flatMap((g) => tools.filter((t) => t.group === g));
}

/** How long the pointer or focus rests on a button before its tooltip shows, in ms. */
export const TIP_DELAY = 120;
/** For this long after a tooltip hides, the next one shows at once, in ms. */
const TIP_WARM = 400;

/** Stops native presses (and double-clicks) before they reach the wrapper's gestures. */
const stopRailPresses = stopNativeEvents('pointerdown', 'mousedown', 'dblclick');

const RAIL_STYLE: CSSProperties = {
  position: 'absolute',
  left: 2,
  top: '50%',
  transform: 'translateY(-50%)',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: 2,
  border: '1px solid var(--cds-border-subtle)',
  borderRadius: 2,
  background: 'var(--cds-layer)',
  zIndex: 2,
};

const SEPARATOR_STYLE: CSSProperties = {
  height: 1,
  margin: '2px 3px',
  background: 'var(--cds-border-subtle)',
};

const tipStyle = (top: number): CSSProperties => ({
  position: 'absolute',
  left: 'calc(100% + 6px)',
  top,
  transform: 'translateY(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 8px',
  borderRadius: 3,
  background: 'var(--cds-background-inverse)',
  color: 'var(--cds-text-inverse)',
  fontSize: 12,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  zIndex: 5,
});

const KBD_STYLE: CSSProperties = {
  fontFamily: 'var(--canopy-font-mono)',
  fontSize: 11,
  opacity: 0.7,
};

// Pressed reads at a glance: the selected layer plus an interactive inset ring.
const buttonStyle = (pressed: boolean, disabled: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  padding: 0,
  margin: 0,
  border: 'none',
  borderRadius: 2,
  background: pressed ? 'var(--cds-layer-selected)' : 'transparent',
  boxShadow: pressed ? 'inset 0 0 0 1px var(--cds-border-interactive)' : 'none',
  color: disabled ? 'var(--cds-text-disabled)' : 'var(--cds-icon-primary, var(--cds-text-primary))',
  font: 'inherit',
  cursor: disabled ? 'default' : 'pointer',
});

/** The tooltip a button shows: its name, and its key when it has one. */
interface Tip {
  text: string;
  shortcut: string;
}

interface ToggleProps {
  label: string;
  tip: Tip;
  pressed: boolean;
  disabled: boolean;
  icon: Icon;
  onToggle: () => void;
  /** The pointer or focus arrived on / left the button. */
  onTip: (el: HTMLElement | null, tip: Tip | null) => void;
  /** The id of the shown tooltip while it is this button's. */
  describedBy?: string;
  data?: Record<string, string>;
}

function Toggle({
  label,
  tip,
  pressed,
  disabled,
  icon: IconCmp,
  onToggle,
  onTip,
  describedBy,
  data,
}: ToggleProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onPointerEnter={(e) => onTip(e.currentTarget, tip)}
      onPointerLeave={() => onTip(null, null)}
      onFocus={(e) => onTip(e.currentTarget, tip)}
      onBlur={() => onTip(null, null)}
      style={buttonStyle(pressed, disabled)}
      {...data}
    >
      <IconCmp size={16} />
    </button>
  );
}

/**
 * The rail's fast tooltip: shows {@link TIP_DELAY} ms after `point` is called
 * with a button, at once within {@link TIP_WARM} ms of the last one hiding.
 */
function useRailTip() {
  const [shown, setShown] = useState<(Tip & { top: number }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmUntil = useRef(0);
  // Mirrors `shown` as each update is made, for the handlers.
  const shownRef = useRef(shown);
  const show = (next: typeof shown) => {
    shownRef.current = next;
    setShown(next);
  };
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const point = (el: HTMLElement | null, tip: Tip | null) => {
    clear();
    if (!el || !tip) {
      if (shownRef.current) warmUntil.current = Date.now() + TIP_WARM;
      show(null);
      return;
    }
    const next = { ...tip, top: el.offsetTop + el.offsetHeight / 2 };
    if (shownRef.current || Date.now() < warmUntil.current) show(next);
    else timer.current = setTimeout(() => show(next), TIP_DELAY);
  };
  return { shown, point };
}

export function DrawingRail({
  prefs,
  onPrefs,
  hidden,
  onHiddenChange,
  view,
  onView,
  focusRoot,
  catalog,
}: DrawingRailProps) {
  const tools = useMemo(() => railToolsIn(catalog), [catalog]);
  const patch = (p: Partial<AnnotationToolPrefs>) => {
    if (!onPrefs) return;
    onPrefs(p);
    focusRoot?.();
  };
  const values = { prefs, hidden: hidden === true, view };
  const viewPatch = (p: Partial<PlotView>) => {
    onView?.(p);
    focusRoot?.();
  };
  const writers = { onPrefs: onPrefs && patch, onHiddenChange, onView: onView && viewPatch };
  const toggles = PLOT_TOGGLES.flatMap((spec) => {
    const click = spec.click(values, writers);
    if (!click && spec.unwired === 'omit') return [];
    return [{ spec, click }];
  });
  const { shown, point } = useRailTip();
  const tipId = useId();
  const describedBy = (text: string) => (shown?.text === text ? tipId : undefined);
  return (
    <div
      ref={stopRailPresses}
      data-drawing-rail=""
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="vertical"
      style={RAIL_STYLE}
    >
      {tools.map(({ kind, icon, group, label, shortcut }, i) => {
        const armed = prefs.tool === kind;
        return (
          <Fragment key={kind}>
            {i > 0 && tools[i - 1].group !== group && (
              <div aria-hidden="true" style={SEPARATOR_STYLE} />
            )}
            <Toggle
              label={label}
              tip={{ text: label, shortcut }}
              pressed={armed}
              disabled={!onPrefs}
              icon={icon}
              onTip={point}
              describedBy={describedBy(label)}
              data={{ 'data-drawing-tool': kind }}
              onToggle={() => patch({ tool: armed ? 'cursor' : kind })}
            />
          </Fragment>
        );
      })}
      {toggles.map(({ spec, click }, i) => {
        const title = spec.title(values);
        return (
          <Fragment key={spec.toggle}>
            {(i === 0 || toggles[i - 1].spec.group !== spec.group) && (
              <div aria-hidden="true" style={SEPARATOR_STYLE} />
            )}
            <Toggle
              label={spec.label}
              tip={{ text: title, shortcut: '' }}
              pressed={spec.pressed(values)}
              disabled={!click}
              icon={spec.icon(values)}
              onTip={point}
              describedBy={describedBy(title)}
              data={{ 'data-drawing-toggle': spec.toggle }}
              onToggle={() => click?.()}
            />
          </Fragment>
        );
      })}
      {shown && (
        <div id={tipId} role="tooltip" data-rail-tip="" style={tipStyle(shown.top)}>
          <span>{shown.text}</span>
          {shown.shortcut && <kbd style={KBD_STYLE}>{shown.shortcut}</kbd>}
        </div>
      )}
    </div>
  );
}
