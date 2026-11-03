import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CanopyProvider } from '@slaclab/canopy-react';
// Carbon compiled from Sass with self-hosted IBM Plex (index.scss), then the
// shell's styles, then the app's own.
import './index.scss';
import '@slaclab/canopy-shell/styles.css';
import './index.css';
import { setupColorMode } from './state/colorMode';
import App from './App.tsx';
import { canopyConnection } from './api/connection';

// Before the first render: read trace.theme and paint <html> to match.
setupColorMode();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CanopyProvider connection={canopyConnection}>
      <App />
    </CanopyProvider>
  </StrictMode>
);
