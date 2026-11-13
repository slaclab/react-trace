// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createFakeWebSocketFactory } from '@slaclab/canopy-client/testing';
import { LiveStore } from './liveStore';

// The app's connection is a same-origin path; the Hare socket URL is resolved
// against the page, like fetch resolves the REST calls.
describe('LiveStore socket URL', () => {
  it('resolves the per-module layout against the page origin', () => {
    const { factory, instances } = createFakeWebSocketFactory();
    new LiveStore({ connection: { baseUrl: '' }, webSocketFactory: factory }).watch('t', 'X', 1);
    expect(instances[0].url).toBe(`ws://${window.location.host}/hare/v1/ws/pvs`);
  });

  it('keeps a deployed base path in front of the Hare route', () => {
    const { factory, instances } = createFakeWebSocketFactory();
    new LiveStore({
      connection: { baseUrl: '/trace/api/canopy' },
      webSocketFactory: factory,
    }).watch('t', 'X', 1);
    expect(instances[0].url).toBe(`ws://${window.location.host}/trace/api/canopy/hare/v1/ws/pvs`);
  });
});
