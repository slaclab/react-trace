import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ComposedModal,
  ModalHeader,
  ModalBody,
  ModalFooter,
  TextInput,
  TextArea,
  Button,
  InlineNotification,
  InlineLoading,
  StructuredListWrapper,
  StructuredListHead,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
} from '@carbon/react';
import { Copy, TrashCan, Renew } from '@carbon/icons-react';

import type { Plot } from '../types';
import type { ColorMode } from '@slaclab/canopy-shell';
import type { ConfigDTO } from '../api/types';
import { CanopyError } from '../api/client';
import {
  serializeConfigData,
  deserializeConfigData,
  type DeserializeResult,
} from '../io/serialize';
import { saveConfig, getConfig, listConfigs, updateConfig, deleteConfig } from '../api/magpie';

interface ConfigStoreModalProps {
  open: boolean;
  /** Current workspace, captured live for Save. */
  plots: Plot[];
  theme: ColorMode;
  onClose: () => void;
  /** Apply a loaded workspace to app state (shared with file import + ?config=). */
  onLoaded: (result: DeserializeResult) => void;
  /** Emit a success/error toast in the parent. */
  onToast: (t: {
    kind: 'success' | 'error';
    title: string;
    subtitle?: string;
    timeout?: number;
  }) => void;
}

// What the modal is busy with. Save and every row's Load/Rename/Delete share
// this one slot, so only one runs at a time: a successful Load closes the
// modal, which would orphan anything running beside it.
type BusyOp =
  | { kind: 'save' }
  | { kind: 'load' | 'rename' | 'delete'; slug: string; label: string };

const BUSY_VERB = { load: 'Loading', rename: 'Renaming', delete: 'Deleting' } as const;

// One unpaginated page. Truncation is surfaced in the list header rather than
// silently hidden; real paging is slaclab/react-trace#80.
const PAGE_SIZE = 200;

function shareUrl(slug: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('config', slug);
  return url.toString();
}

// How a config is named in the status line and the delete confirmation.
function configLabel(config: ConfigDTO): string {
  return config.name || config.slug;
}

function errText(err: unknown): string {
  if (err instanceof CanopyError) return err.detail;
  return (err as Error | null)?.message ?? 'Unknown error';
}

/** Copy `text`, reporting whether it actually landed (see handleSave). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ConfigStoreModal({
  open,
  plots,
  theme,
  onClose,
  onLoaded,
  onToast,
}: ConfigStoreModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [configs, setConfigs] = useState<ConfigDTO[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [listing, setListing] = useState(false);

  // The one operation in flight (see BusyOp). State drives the render; the ref
  // gives handlers and the close guards the current value without waiting for a
  // re-render, so a second click in the same tick can't also claim the slot.
  const [busy, setBusyState] = useState<BusyOp | null>(null);
  const busyRef = useRef<BusyOp | null>(null);
  const setBusy = useCallback((op: BusyOp | null) => {
    busyRef.current = op;
    setBusyState(op);
  }, []);
  const saving = busy?.kind === 'save';
  const deleting = busy?.kind === 'delete';

  // The config the delete confirmation is asking about. Its ref serves the
  // close guards, like busyRef.
  const [deleteTarget, setDeleteTargetState] = useState<ConfigDTO | null>(null);
  const deleteTargetRef = useRef<ConfigDTO | null>(null);
  const setDeleteTarget = useCallback((config: ConfigDTO | null) => {
    deleteTargetRef.current = config;
    setDeleteTargetState(config);
  }, []);

  // Monotonic refresh id. A Save/Delete fires its own refresh while the open
  // refresh may still be in flight; without this, the slower (older) response
  // could land last and overwrite the newer post-mutation list. Only the latest
  // generation commits.
  const refreshGen = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++refreshGen.current;
    setError(null);
    setListing(true);
    try {
      const page = await listConfigs({ pageSize: PAGE_SIZE });
      if (gen !== refreshGen.current) return;
      // Magpie orders by its (random UUID) primary key, so sort here to get a
      // predictable newest-first list. See slaclab/canopy#90 for the server-side
      // ordering fix and slaclab/react-trace#80 for paging past PAGE_SIZE.
      setConfigs(
        [...page.results].sort(
          (a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime()
        )
      );
      setTotalCount(page.totalCount ?? null);
    } catch (err) {
      if (gen !== refreshGen.current) return;
      setError(errText(err));
    } finally {
      if (gen === refreshGen.current) setListing(false);
    }
  }, []);

  // Each open of the modal is a session. Closing or unmounting ends it and
  // aborts a pending Load, and an operation applies its result only while its
  // session is current, so a dismissed Load can't replace the workspace after
  // the dialog is gone. Save, Rename and Delete block dismissal until their
  // server call settles, so their session ends before that only if the parent
  // closes the modal itself or unmounts it. Their outcome is then dropped, apart
  // from Save's toast, which also outlives a close during the share-link copy.
  const sessionRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const endSession = useCallback(() => {
    sessionRef.current++;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
  }, []);
  useEffect(() => endSession, [endSession]);

  // Load the list on open. Nothing resets the form or the slot here: TraceApp
  // mounts the modal only while it's open, so each open starts from fresh state.
  useEffect(() => {
    if (!open) {
      endSession();
      return;
    }
    void Promise.resolve().then(refresh);
  }, [open, refresh, endSession]);

  // Carbon's X, Escape and backdrop all call this; returning false keeps the
  // dialog open. Save, Rename and Delete block dismissal until their server
  // call settles: the change happens either way, so closing would only hide
  // its outcome. So does an open delete confirmation. A Load doesn't block;
  // closing cancels it.
  // This must read refs, not render state. Carbon registers its Escape listener
  // once per open and keeps the onClose from that render, when nothing was busy.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => {
    const op = busyRef.current;
    if (op && op.kind !== 'load') return false;
    if (deleteTargetRef.current) return false;
    // The `!open` effect ends the session as well, but only once React has
    // committed the close; ending it here leaves no gap for a response.
    endSession();
    onCloseRef.current();
  }, [endSession]);

  // The delete confirmation's X, Escape and Cancel. It stays open while the
  // Delete's server call runs, so a failure can show in it. Reads the slot's
  // ref for the same reason as requestClose. Closing it drops that failure too,
  // or the store's banner would show it for a Delete that was cancelled.
  const requestCancelDelete = useCallback(() => {
    if (busyRef.current?.kind === 'delete') return false;
    setError(null);
    setDeleteTarget(null);
  }, [setDeleteTarget]);

  // Claim the slot for `op`. Returns the session it runs in, or null if another
  // operation holds the slot.
  const begin = (op: BusyOp): number | null => {
    if (busyRef.current) return null;
    setBusy(op);
    setError(null);
    return sessionRef.current;
  };
  // Release the slot only if `op` still holds it: Save, Rename and Delete free
  // it before their refresh or copy, so by their `finally` another operation
  // may have claimed it.
  const end = (op: BusyOp) => {
    if (busyRef.current === op) setBusy(null);
  };

  const handleSave = async () => {
    const op: BusyOp = { kind: 'save' };
    const session = begin(op);
    if (session === null) return;
    try {
      const data = serializeConfigData({ theme, plots });
      const dto = await saveConfig(data, {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      });
      // The server call has settled. Neither the refresh nor the clipboard write
      // is part of the save, so neither holds the slot or blocks closing: a
      // pending clipboard permission prompt would otherwise lock the dialog.
      end(op);
      // The form and the list belong to the session.
      if (session === sessionRef.current) {
        setName('');
        setDescription('');
        void refresh();
      }
      // Don't claim a copy that didn't happen: the clipboard API is absent on a
      // non-secure origin and rejects when permission is denied or the document
      // isn't focused. Show the link itself so it can still be copied by hand,
      // in a toast that stays until it's dismissed.
      const link = shareUrl(dto.slug);
      const copied = await copyToClipboard(link);
      // The toast goes out regardless, even if the dialog has closed since: the
      // config exists and its link is useful.
      onToast({
        kind: 'success',
        title: 'Workspace saved',
        subtitle: copied ? `Share link copied to clipboard (${dto.slug})` : `Share link: ${link}`,
        timeout: copied ? undefined : 0,
      });
    } catch (err) {
      if (session === sessionRef.current) setError(errText(err));
    } finally {
      end(op);
    }
  };

  const handleLoad = async (config: ConfigDTO) => {
    const op: BusyOp = { kind: 'load', slug: config.slug, label: configLabel(config) };
    const session = begin(op);
    if (session === null) return;
    const abort = new AbortController();
    loadAbortRef.current = abort;
    try {
      const dto = await getConfig(config.slug, abort.signal);
      // Closing aborts the request, but the response may have arrived first.
      if (session !== sessionRef.current) return;
      const result = deserializeConfigData(dto.data);
      onLoaded(result);
      onToast({
        kind: 'success',
        title: 'Workspace loaded',
        subtitle: [
          dto.name ? `Loaded "${dto.name}"` : `Loaded config ${config.slug}`,
          ...result.warnings,
        ].join('\n'),
        timeout: result.warnings.length > 0 ? 0 : undefined,
      });
      // Like requestClose, end the session before the parent sees the close.
      endSession();
      onClose();
    } catch (err) {
      // A stale session also covers the AbortError from closing.
      if (session === sessionRef.current) setError(errText(err));
    } finally {
      if (loadAbortRef.current === abort) loadAbortRef.current = null;
      end(op);
    }
  };

  const handleRename = async (config: ConfigDTO) => {
    // Don't prompt for an action that can't start.
    if (busyRef.current) return;
    const next = window.prompt('Rename config', config.name ?? '');
    if (next === null) return;
    // No-op a blank rename (Save likewise omits empty names) or an unchanged one.
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === (config.name ?? '')) return;
    const op: BusyOp = { kind: 'rename', slug: config.slug, label: configLabel(config) };
    const session = begin(op);
    if (session === null) return;
    try {
      await updateConfig(config.slug, { name: trimmed });
      if (session !== sessionRef.current) return;
      end(op);
      await refresh();
    } catch (err) {
      if (session === sessionRef.current) setError(errText(err));
    } finally {
      end(op);
    }
  };

  // A row's Delete opens the confirmation; only its Delete button deletes.
  const askDelete = (config: ConfigDTO) => {
    // Don't ask about an action that can't start.
    if (busyRef.current) return;
    setError(null);
    setDeleteTarget(config);
  };

  const handleDelete = async () => {
    const config = deleteTargetRef.current;
    if (!config) return;
    const op: BusyOp = { kind: 'delete', slug: config.slug, label: configLabel(config) };
    const session = begin(op);
    if (session === null) return;
    try {
      await deleteConfig(config.slug);
      if (session !== sessionRef.current) return;
      setDeleteTarget(null);
      end(op);
      await refresh();
    } catch (err) {
      // The confirmation stays open and shows it, so the Delete can be retried.
      if (session === sessionRef.current) setError(errText(err));
    } finally {
      end(op);
    }
  };

  const handleCopyLink = async (slug: string) => {
    const link = shareUrl(slug);
    if (await copyToClipboard(link)) {
      onToast({ kind: 'success', title: 'Link copied', subtitle: link });
    } else {
      onToast({ kind: 'error', title: 'Could not copy link', subtitle: link });
    }
  };

  return (
    <>
      <ComposedModal open={open} onClose={requestClose} size="lg" aria-label="Config store">
        <ModalHeader title="Config store" />
        <ModalBody hasScrollingContent>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 4 }}>
            {error && !deleteTarget && (
              <InlineNotification
                kind="error"
                title="Error"
                subtitle={error}
                onCloseButtonClick={() => setError(null)}
              />
            )}

            {/* Save the current workspace */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span className="cds--label" style={{ marginBottom: 0 }}>
                Save current workspace
              </span>
              <TextInput
                id="config-name"
                labelText="Name"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                placeholder="e.g. LI22 klystron overview"
                maxLength={255}
              />
              <TextArea
                id="config-description"
                labelText="Description (optional)"
                value={description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setDescription(e.target.value)
                }
                rows={2}
              />
              <div>
                <Button onClick={handleSave} disabled={busy !== null}>
                  {saving ? 'Saving…' : 'Save & copy share link'}
                </Button>
              </div>
            </div>

            {/* Browse / manage saved configs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="cds--label" style={{ marginBottom: 0 }}>
                  Saved configs
                  {totalCount !== null && totalCount > configs.length
                    ? ` (showing ${configs.length} of ${totalCount})`
                    : ''}
                </span>
                <Button
                  kind="ghost"
                  size="sm"
                  hasIconOnly
                  iconDescription="Refresh"
                  renderIcon={Renew}
                  onClick={() => void refresh()}
                  disabled={listing}
                />
                {/* Save shows its progress on its own button. */}
                {busy && busy.kind !== 'save' && (
                  <InlineLoading description={`${BUSY_VERB[busy.kind]} "${busy.label}"…`} />
                )}
              </div>

              {listing ? (
                <InlineLoading description="Loading configs…" />
              ) : configs.length === 0 ? (
                <p style={{ color: 'var(--cds-text-secondary)' }}>No saved configs yet.</p>
              ) : (
                <StructuredListWrapper isCondensed>
                  <StructuredListHead>
                    <StructuredListRow head>
                      <StructuredListCell head>Name</StructuredListCell>
                      <StructuredListCell head>Created</StructuredListCell>
                      <StructuredListCell head>Actions</StructuredListCell>
                    </StructuredListRow>
                  </StructuredListHead>
                  <StructuredListBody>
                    {configs.map((c) => (
                      <StructuredListRow key={c.slug}>
                        <StructuredListCell>
                          {c.name || (
                            <em style={{ color: 'var(--cds-text-secondary)' }}>untitled</em>
                          )}
                          <div style={{ fontSize: 12, color: 'var(--cds-text-secondary)' }}>
                            {c.slug}
                          </div>
                        </StructuredListCell>
                        <StructuredListCell>
                          {new Date(c.createdDate).toLocaleString()}
                        </StructuredListCell>
                        <StructuredListCell>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            <Button
                              size="sm"
                              kind="tertiary"
                              onClick={() => void handleLoad(c)}
                              disabled={busy !== null}
                            >
                              Load
                            </Button>
                            <Button
                              size="sm"
                              kind="ghost"
                              onClick={() => void handleRename(c)}
                              disabled={busy !== null}
                            >
                              Rename
                            </Button>
                            <Button
                              size="sm"
                              kind="ghost"
                              hasIconOnly
                              iconDescription="Copy share link"
                              renderIcon={Copy}
                              onClick={() => void handleCopyLink(c.slug)}
                            />
                            <Button
                              size="sm"
                              kind="danger--ghost"
                              hasIconOnly
                              iconDescription="Delete"
                              renderIcon={TrashCan}
                              onClick={() => askDelete(c)}
                              disabled={busy !== null}
                            />
                          </div>
                        </StructuredListCell>
                      </StructuredListRow>
                    ))}
                  </StructuredListBody>
                </StructuredListWrapper>
              )}
            </div>
          </div>
        </ModalBody>
      </ComposedModal>

      <ComposedModal
        open={Boolean(deleteTarget)}
        onClose={requestCancelDelete}
        size="sm"
        danger
        aria-label="Delete config?"
      >
        <ModalHeader title="Delete config?" />
        <ModalBody>
          {error && (
            <InlineNotification
              kind="error"
              title="Could not delete config"
              subtitle={error}
              onCloseButtonClick={() => setError(null)}
            />
          )}
          {deleteTarget && (
            <p>
              Delete <strong>{configLabel(deleteTarget)}</strong>? This will break any shared links
              to it. This action cannot be undone.
            </p>
          )}
        </ModalBody>
        {deleteTarget && (
          <ModalFooter
            dangerDescription="This will permanently delete the config and break its shared links."
            secondaryButtonText="Cancel"
            primaryButtonText={deleting ? 'Deleting…' : 'Delete'}
            primaryButtonDisabled={deleting}
            onRequestClose={requestCancelDelete}
            onRequestSubmit={() => void handleDelete()}
          >
            {null}
          </ModalFooter>
        )}
      </ComposedModal>
    </>
  );
}
