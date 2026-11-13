import { ColorModeTheme } from '@slaclab/canopy-shell';
import { TraceApp } from './components/TraceApp';
import './App.css';

export default function App() {
  // The SLAC standard page themes, from the canopy-shell color-mode store: g10
  // in light mode, g100 in dark mode. The header follows the page theme.
  return (
    <ColorModeTheme style={{ height: '100%' }}>
      <TraceApp />
    </ColorModeTheme>
  );
}
