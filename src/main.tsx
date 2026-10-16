import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CanopyProvider } from '@slaclab/canopy-react';
import './index.css';
import App from './App.tsx';
import { canopyConnection } from './api/connection';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CanopyProvider connection={canopyConnection}>
      <App />
    </CanopyProvider>
  </StrictMode>
);
