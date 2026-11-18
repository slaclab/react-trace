import './bootstrap';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CanopyProvider } from '@slaclab/canopy-react';
import App from './App.tsx';
import { canopyConnection } from './api/connection';
import { startPage } from './site/load';

// The site defaults first (src/site), so the first render opens with them.
void startPage(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <CanopyProvider connection={canopyConnection}>
        <App />
      </CanopyProvider>
    </StrictMode>
  )
);
