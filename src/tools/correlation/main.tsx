// The correlation plot's app entry (correlation.html), a second page beside
// Trace's index.html in the same build. It opens with the state its URL query
// carries (query.ts) and, while embedded, reports state changes back to the
// host (stateOut.ts). The bridge is Trace's: same `canopy:trace-*` messages.

import '../../bootstrap';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HarePVService } from '@slaclab/canopy-client';
import { CanopyProvider } from '@slaclab/canopy-react';
import { canopyConnection } from '../../api/connection';
import { CorrelationApp } from './App';
import { hareServiceOptions } from '../shared/canopyServices';

// The instance's one Hare connection, opened once per page (outside React so
// StrictMode's double mount does not open a second socket).
const hare = new HarePVService(hareServiceOptions());
hare.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CanopyProvider connection={canopyConnection}>
      <CorrelationApp hare={hare} />
    </CanopyProvider>
  </StrictMode>
);
