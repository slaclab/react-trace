// The Waveform tool's app entry (waveform.html), the third page beside
// Trace's index.html and correlation.html in the same build. It opens with the
// state its URL query carries (query.ts) and, while embedded, reports state
// changes back to the host (stateOut.ts) over Trace's bridge.

import '../../bootstrap';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HarePVService } from '@slaclab/canopy-client';
import { CanopyProvider } from '@slaclab/canopy-react';
import { canopyConnection } from '../../api/connection';
import { WaveformApp } from './App';
import { hareServiceOptions } from '../shared/canopyServices';

// The page's one Hare connection, opened once (outside React so StrictMode's
// double mount does not open a second socket).
const hare = new HarePVService(hareServiceOptions());
hare.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CanopyProvider connection={canopyConnection}>
      <WaveformApp hare={hare} />
    </CanopyProvider>
  </StrictMode>
);
