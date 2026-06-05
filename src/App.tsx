import { Theme } from '@carbon/react';
import { TraceApp } from './components/TraceApp';
import { useColorMode } from './state/themeStore';
import './App.css';

export default function App() {
  const { colorMode } = useColorMode();
  // Body theme follows colorMode (g90 = "darkest readable", g10 = "lightest").
  // The header inside TraceApp is wrapped in its own <Theme theme="g100"> so
  // the brand bar stays dark in light mode — same convention as react-squirrel.
  return (
    <Theme theme={colorMode === 'dark' ? 'g90' : 'g10'} style={{ height: '100%' }}>
      <TraceApp />
    </Theme>
  );
}
