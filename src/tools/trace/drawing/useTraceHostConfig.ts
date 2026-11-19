// The hook form of the Trace host config: one config per
// mount, live data mirrored into a ref after each commit, and the frame store
// bumped when the plot's line data changes.
import { useLayoutEffect, useMemo, useState } from 'react';
import { createTraceHostConfig, type TraceDrawingData, type TraceHostConfig } from './hostConfig';

export function useTraceHostConfig(data: TraceDrawingData): TraceHostConfig {
  // Built once per mount, never keyed on the frame.
  const config = useMemo(
    () => createTraceHostConfig(data),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- built once; data flows through setData
    []
  );
  // The live data, after each commit, before any event or card can read it.
  useLayoutEffect(() => {
    config.setData(data);
  });
  // After the mirror above (effects run in order): the card re-reads fresh data.
  const { traceData } = data;
  const [mountedData] = useState(traceData);
  useLayoutEffect(() => {
    if (traceData !== mountedData) config.frames.bump();
  }, [config, traceData, mountedData]);
  return config;
}
