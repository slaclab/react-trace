import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CanopyProvider } from '@slaclab/canopy-react';
import './index.css';
// After Carbon's CSS (imported first by index.css), before the app's own.
import '@slaclab/canopy-shell/styles.css';
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
