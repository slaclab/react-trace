import { useEffect, useState } from 'react';
import { Dropdown } from '@carbon/react';
import { CanopyError, listArchivers, type ArchiverInfoDTO } from '@slaclab/canopy-client';
import { useCanopyConnection } from '@slaclab/canopy-react';

export const GLOBAL_DEFAULT_OPTION = '__default__';
export const GLOBAL_OPTION = '__global__';

interface ArchiverPickerProps {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  // When true, includes a "Use plot default" option that maps to undefined.
  // Used by per-trace overrides; the plot's own picker omits it.
  includeGlobalOption?: boolean;
  size?: 'sm' | 'md';
  label?: string;
  width?: number | string;
}

interface ArchiverItem {
  id: string;
  label: string;
  healthy?: boolean;
}

export function ArchiverPicker({
  value,
  onChange,
  includeGlobalOption = false,
  size = 'sm',
  label = 'Archiver',
  width = 200,
}: ArchiverPickerProps) {
  const conn = useCanopyConnection();
  const [archivers, setArchivers] = useState<ArchiverInfoDTO[]>([]);
  const [defaultName, setDefaultName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const list = await listArchivers(conn, controller.signal);
        if (controller.signal.aborted) return;
        setArchivers(list.archivers);
        setDefaultName(list.default);
        setError(null);
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        setError(err instanceof CanopyError ? err.detail : (err as Error).message);
      }
    })();
    return () => controller.abort();
  }, [conn]);

  const items: ArchiverItem[] = [];
  if (includeGlobalOption) {
    items.push({ id: GLOBAL_OPTION, label: 'Use plot default' });
  } else {
    items.push({
      id: GLOBAL_DEFAULT_OPTION,
      label: defaultName ? `Default (${defaultName})` : 'Default',
    });
  }
  for (const a of archivers) {
    items.push({ id: a.name, label: a.name, healthy: a.healthy });
  }

  const selectedId = includeGlobalOption
    ? (value ?? GLOBAL_OPTION)
    : (value ?? GLOBAL_DEFAULT_OPTION);
  const selectedItem = items.find((i) => i.id === selectedId) ?? items[0];

  return (
    <div style={{ width, minWidth: width }}>
      <Dropdown
        id={`archiver-picker-${includeGlobalOption ? 'override' : 'global'}`}
        titleText={label}
        label={label || 'Archiver'}
        hideLabel={label === ''}
        size={size}
        items={items}
        itemToString={(item: ArchiverItem | null) => {
          if (!item) return '';
          if (item.id === GLOBAL_OPTION || item.id === GLOBAL_DEFAULT_OPTION) return item.label;
          const dot = item.healthy === false ? ' ●' : '';
          return `${item.label}${dot}`;
        }}
        selectedItem={selectedItem}
        onChange={({ selectedItem: next }: { selectedItem?: ArchiverItem | null }) => {
          if (!next) return;
          if (next.id === GLOBAL_OPTION || next.id === GLOBAL_DEFAULT_OPTION) {
            onChange(undefined);
          } else {
            onChange(next.id);
          }
        }}
        invalid={Boolean(error)}
        invalidText={error ?? ''}
      />
    </div>
  );
}
