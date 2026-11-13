import type { ReactNode } from 'react';
import type { CanopyConnection } from '@slaclab/canopy-client';
import { CanopyProvider } from '@slaclab/canopy-react';

// One object for every render: a new connection would read as a new Canopy.
const CONNECTION: CanopyConnection = { baseUrl: '' };

/**
 * Components and hooks read their Canopy connection from <CanopyProvider>.
 * Tests that fake the SDK calls (or never let a request out) need only some
 * connection: the same-origin per-module paths. Pass as `{ wrapper }` to
 * render() or renderHook().
 */
export function WithCanopy({ children }: { children: ReactNode }) {
  return <CanopyProvider connection={CONNECTION}>{children}</CanopyProvider>;
}
