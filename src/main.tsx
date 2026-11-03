import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Carbon compiled from Sass with self-hosted IBM Plex, then the app's own CSS.
import './index.scss';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
