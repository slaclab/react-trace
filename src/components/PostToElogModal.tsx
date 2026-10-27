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

import { describeElogError, listLogbooks, postEntry } from '../api/elog';
import type { ElogEntryCreatedDTO, ElogLogbookDTO } from '../api/types';
import { capturedToFile, type CapturedPlot } from '../io/exportPlotImage';

interface PostToElogModalProps {
  open: boolean;
  /** Plots captured as PNGs at the moment the dialog opened. */
  captured: CapturedPlot[];
  /** Logbook ids preselected once the logbook list loads (from Canopy's config). */
  defaultLogbookIds: string[];
  /** Lazily builds the workspace config file when "Attach config" is checked. */
  buildConfigFile: () => File;
  onClose: () => void;
  onPosted?: (entry: ElogEntryCreatedDTO) => void;
  onPostFailed?: (message: string) => void;
}

export function PostToElogModal({
  open,
  captured,
  defaultLogbookIds,
  buildConfigFile,
  onClose,
  onPosted,
  onPostFailed,
}: PostToElogModalProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  // null while the logbook list is loading for this open.
  const [logbooks, setLogbooks] = useState<ElogLogbookDTO[] | null>(null);
  const [logbooksError, setLogbooksError] = useState<string | null>(null);
  const [selectedLogbookIds, setSelectedLogbookIds] = useState<string[]>([]);
  const [selectedPlotIds, setSelectedPlotIds] = useState<string[]>([]);
  const [attachConfig, setAttachConfig] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bumped on each open so the FilterableMultiSelect below remounts. Carbon's
  // multiselect tracks its own selection from initialSelectedItems and does not
  // reset when that prop changes, so without a fresh key it would keep showing
  // the previous post's logbook chips while our state says none are selected.
  const [openCount, setOpenCount] = useState(0);

  // Files built and attachments uploaded by earlier attempts in this open, so a
  // retry after a failed post reuses them instead of uploading them again. Plot
  // files are keyed by index too because the name embeds the plot's position
  // among the selected ones.
  const builtFiles = useRef(new Map<string, File>());
  const uploaded = useRef(new Map<File, string>());

  // Initialize form state once per open. captured is a snapshot taken at open
  // time, so we don't want to clobber edits if it changes underneath.
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
    setLogbooks(null);
    setLogbooksError(null);
    setSelectedLogbookIds([]);
    setSelectedPlotIds(captured.map((c) => c.id));
    setAttachConfig(false);
    setPosting(false);
    setError(null);
    setOpenCount((n) => n + 1);
    builtFiles.current.clear();
    uploaded.current.clear();
  }, [open, captured]);

  // Load the logbook list on each open, so a list that failed (or changed) last
  // time is fetched again, then preselect the configured defaults it contains.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    listLogbooks(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        const known = new Set(items.map((lb) => lb.id));
        setLogbooks(items);
        setSelectedLogbookIds(defaultLogbookIds.filter((id) => known.has(id)));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLogbooks([]);
        setLogbooksError(describeElogError(err));
      });
    return () => controller.abort();
  }, [open, defaultLogbookIds]);

  const selectedCaptured = useMemo(
    () => captured.filter((c) => selectedPlotIds.includes(c.id)),
    [captured, selectedPlotIds]
  );

  const canPost = !posting && title.trim().length > 0 && selectedLogbookIds.length > 0;

  const togglePlot = (id: string, checked: boolean) => {
    setSelectedPlotIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((p) => p !== id)
    );
  };

  const handlePost = async () => {
    setPosting(true);
    setError(null);
    try {
      const fileFor = (key: string, build: () => File): File => {
        let file = builtFiles.current.get(key);
        if (!file) {
          file = build();
          builtFiles.current.set(key, file);
        }
        return file;
      };
      const files = selectedCaptured.map((c, i) =>
        fileFor(`plot:${c.id}:${i}`, () => capturedToFile(c, i))
      );
      if (attachConfig) files.push(fileFor('config', buildConfigFile));

      const entry = await postEntry({
        title: title.trim(),
        bodyMarkdown: body,
        logbookIds: selectedLogbookIds,
        files,
        uploaded: uploaded.current,
      });
      onPosted?.(entry);
      onClose();
    } catch (err) {
      const message = describeElogError(err);
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
          {logbooksError && (
            <InlineNotification
              kind="error"
              title="Couldn't load logbooks"
              subtitle={logbooksError}
              hideCloseButton
            />
          )}

          <FilterableMultiSelect
            key={`elog-logbooks-${openCount}-${logbooks ? 'loaded' : 'loading'}`}
            id="elog-logbooks"
            titleText="Logbooks"
            items={logbooks ?? []}
            itemToString={(lb: ElogLogbookDTO | null) => lb?.name ?? ''}
            initialSelectedItems={(logbooks ?? []).filter((lb) =>
              selectedLogbookIds.includes(lb.id)
            )}
            onChange={({ selectedItems }: { selectedItems: ElogLogbookDTO[] }) =>
              setSelectedLogbookIds(selectedItems.map((lb) => lb.id))
            }
            placeholder={logbooks ? 'Select logbooks' : 'Loading logbooks...'}
            disabled={!logbooks}
            invalid={!!logbooks && !logbooksError && selectedLogbookIds.length === 0}
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
            labelText="Body (Markdown)"
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
