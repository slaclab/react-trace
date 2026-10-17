import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ComposedModal,
  ModalHeader,
  ModalBody,
  ModalFooter,
  FilterableMultiSelect,
  TextInput,
  TextArea,
  Checkbox,
  InlineNotification,
} from '@carbon/react';

import { postEntry } from '../api/elog';
import type { ElogLogbook } from '../api/elog';
import { capturedToFile, type CapturedPlot } from '../io/exportPlotImage';

interface PostToElogModalProps {
  open: boolean;
  /** Plots captured as PNGs at the moment the dialog opened. */
  captured: CapturedPlot[];
  logbooks: ElogLogbook[];
  defaultLogbooks: string[];
  /** Lazily builds the workspace config file when "Attach config" is checked. */
  buildConfigFile: () => File;
  onClose: () => void;
  onPosted?: (entryId: string) => void;
  onPostFailed?: (message: string) => void;
}

export function PostToElogModal({
  open,
  captured,
  logbooks,
  defaultLogbooks,
  buildConfigFile,
  onClose,
  onPosted,
  onPostFailed,
}: PostToElogModalProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [selectedLogbooks, setSelectedLogbooks] = useState<string[]>([]);
  const [selectedPlotIds, setSelectedPlotIds] = useState<string[]>([]);
  const [attachConfig, setAttachConfig] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bumped on each open so the FilterableMultiSelect below remounts. Carbon's
  // multiselect tracks its own selection from initialSelectedItems and does not
  // reset when that prop changes, so without a fresh key it would keep showing
  // the previous post's logbook chips while our state says none are selected.
  const [openCount, setOpenCount] = useState(0);

  // Initialize form state once per open. captured/defaults are snapshots taken
  // at open time, so we don't want to clobber edits if they change underneath.
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (initialized.current) return;
    initialized.current = true;
    setTitle('');
    setBody('');
    setSelectedLogbooks(defaultLogbooks);
    setSelectedPlotIds(captured.map((c) => c.id));
    setAttachConfig(false);
    setPosting(false);
    setError(null);
    setOpenCount((n) => n + 1);
  }, [open, captured, defaultLogbooks]);

  const selectedCaptured = useMemo(
    () => captured.filter((c) => selectedPlotIds.includes(c.id)),
    [captured, selectedPlotIds]
  );

  const canPost = !posting && title.trim().length > 0 && selectedLogbooks.length > 0;

  const togglePlot = (id: string, checked: boolean) => {
    setSelectedPlotIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((p) => p !== id)
    );
  };

  const handlePost = async () => {
    setPosting(true);
    setError(null);
    try {
      const files: File[] = [];
      selectedCaptured.forEach((c, i) => files.push(capturedToFile(c, i)));
      if (attachConfig) files.push(buildConfigFile());

      const result = await postEntry({
        title: title.trim(),
        body,
        logbooks: selectedLogbooks,
        files,
      });
      onPosted?.(result.id);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to post entry';
      setError(message);
      onPostFailed?.(message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <ComposedModal open={open} onClose={posting ? undefined : onClose} size="lg">
      <ModalHeader title="Post to E-Log" />
      <ModalBody hasScrollingContent>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 4 }}>
          {error && (
            <InlineNotification kind="error" title="Error" subtitle={error} hideCloseButton />
          )}

          <FilterableMultiSelect
            key={`elog-logbooks-${openCount}`}
            id="elog-logbooks"
            titleText="Logbooks"
            items={logbooks}
            itemToString={(lb: ElogLogbook | null) => lb?.name ?? ''}
            initialSelectedItems={logbooks.filter((lb) => selectedLogbooks.includes(lb.name))}
            onChange={({ selectedItems }: { selectedItems: ElogLogbook[] }) =>
              setSelectedLogbooks(selectedItems.map((lb) => lb.name))
            }
            placeholder="Select logbooks"
            invalid={selectedLogbooks.length === 0}
            invalidText="At least one logbook is required"
          />

          <TextInput
            id="elog-title"
            labelText="Title"
            value={title}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
            maxLength={255}
            required
          />

          <TextArea
            id="elog-body"
            labelText="Body"
            value={body}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setBody(e.target.value)}
            rows={6}
            placeholder="Optional entry body"
          />

          {captured.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="cds--label" style={{ marginBottom: 0 }}>
                Attach plots
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {captured.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      border: '1px solid var(--cds-border-subtle-01)',
                      borderRadius: 4,
                      padding: 8,
                      width: 180,
                    }}
                  >
                    <Checkbox
                      id={`elog-plot-${c.id}`}
                      labelText={c.title}
                      checked={selectedPlotIds.includes(c.id)}
                      onChange={(_e: unknown, { checked }: { checked: boolean }) =>
                        togglePlot(c.id, checked)
                      }
                    />
                    <img
                      src={c.dataUrl}
                      alt={`Preview of ${c.title}`}
                      style={{
                        width: '100%',
                        height: 'auto',
                        opacity: selectedPlotIds.includes(c.id) ? 1 : 0.4,
                        border: '1px solid var(--cds-border-subtle-01)',
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <Checkbox
            id="elog-attach-config"
            labelText="Attach current configuration (trace_config.json)"
            checked={attachConfig}
            onChange={(_e: unknown, { checked }: { checked: boolean }) => setAttachConfig(checked)}
          />
        </div>
      </ModalBody>
      <ModalFooter
        secondaryButtonText="Cancel"
        primaryButtonText={posting ? 'Posting...' : 'Post'}
        primaryButtonDisabled={!canPost}
        onRequestSubmit={handlePost}
        onRequestClose={posting ? undefined : onClose}
      >
        {null}
      </ModalFooter>
    </ComposedModal>
  );
}
