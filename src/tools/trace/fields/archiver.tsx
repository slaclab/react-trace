// Trace's Default archiver custom field: today's ArchiverPicker in its plot
// mode, where "Default (<name>)" is `undefined` (the backend default). The
// picker's own Dropdown keeps its id, so the field's `#id` sits on the wrapper.

import type { ReactNode } from 'react';
import { ArchiverPicker } from '../../../components/ArchiverPicker';

export interface ArchiverControlProps {
  id?: string;
  value: string | undefined;
  onChange(value: string | undefined): void;
}

export function ArchiverControl({ id, value, onChange }: ArchiverControlProps): ReactNode {
  return (
    <div id={id} className="trace-archiver">
      <ArchiverPicker value={value} onChange={onChange} label="" width="100%" />
    </div>
  );
}
