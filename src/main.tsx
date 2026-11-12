import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Carbon compiled from Sass with self-hosted IBM Plex, then the app's own CSS.
import './index.scss';
import './index.css';
// After Carbon's CSS (imported first by index.css), before the app's own.
import '@slaclab/canopy-shell/styles.css';
import { setupColorMode } from './state/colorMode';
import App from './App.tsx';

// Before the first render: read trace.theme and paint <html> to match.
setupColorMode();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
