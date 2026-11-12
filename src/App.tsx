import { Theme } from '@carbon/react';
import { useColorMode, useHostTheme } from '@slaclab/canopy-shell';
import { TraceApp } from './components/TraceApp';
import { useHostThemeId } from './state/colorMode';
import './App.css';

export default function App() {
  // The SLAC standard page themes, from the canopy-shell color-mode store: g10
  // in light mode, g100 in dark mode. The header follows the page theme.
  const { colorMode, carbonTheme } = useColorMode();
  // The zone is also the host-theme anchor: it names the host's theme (the
  // colour mode when standalone) and hosts Carbon's floating menus, so they
  // open inside the themed subtree.
  const { anchorRef, anchorProps } = useHostTheme<HTMLDivElement>(
    useHostThemeId() ?? colorMode,
    colorMode
  );
  return (
    <Theme ref={anchorRef} {...anchorProps} theme={carbonTheme} style={{ height: '100%' }}>
      <TraceApp />
    </Theme>
  );
}
