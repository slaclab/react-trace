import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ComposedModal,
  ModalHeader,
  ModalBody,
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
import type { ColorMode } from '../state/themeStore';
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
  onToast: (t: { kind: 'success' | 'error'; title: string; subtitle?: string }) => void;
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
  // gives handlers and the close guard the current value without waiting for a
  // re-render, so a second click in the same tick can't also claim the slot.
  const [busy, setBusyState] = useState<BusyOp | null>(null);
  const busyRef = useRef<BusyOp | null>(null);
  const setBusy = useCallback((op: BusyOp | null) => {
    busyRef.current = op;
    setBusyState(op);
  }, []);
  const saving = busy?.kind === 'save';

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

  // Reset the form and reload the list once per open.
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (initialized.current) return;
    initialized.current = true;
    setName('');
    setDescription('');
    setError(null);
    void refresh();
  }, [open, refresh]);

  // Carbon's X, Escape and backdrop all call this; returning false keeps the
  // dialog open. Save, Rename and Delete block dismissal until they settle: the
  // server change happens either way, so closing would only hide its outcome.
  // This must read refs, not render state. Carbon registers its Escape listener
  // once per open and keeps the onClose from that render, when nothing was busy.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => {
    const op = busyRef.current;
    if (op && op.kind !== 'load') return false;
    onCloseRef.current();
  }, []);

  // Claim the slot for `op`; false if another operation holds it.
  const begin = (op: BusyOp): boolean => {
    if (busyRef.current) return false;
    setBusy(op);
    setError(null);
    return true;
  };
  // Release the slot only if `op` still holds it.
  const end = (op: BusyOp) => {
    if (busyRef.current === op) setBusy(null);
  };

  const handleSave = async () => {
    const op: BusyOp = { kind: 'save' };
    if (!begin(op)) return;
    try {
      const data = serializeConfigData({ theme, plots });
      const dto = await saveConfig(data, {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      });
      // Don't claim a copy that didn't happen: the clipboard API is absent on a
      // non-secure origin and rejects when permission is denied or the document
      // isn't focused. Show the link itself so it can still be copied by hand.
      const link = shareUrl(dto.slug);
      const copied = await copyToClipboard(link);
      onToast({
        kind: 'success',
        title: 'Workspace saved',
        subtitle: copied ? `Share link copied to clipboard (${dto.slug})` : `Share link: ${link}`,
      });
      setName('');
      setDescription('');
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      end(op);
    }
  };

  const handleLoad = async (config: ConfigDTO) => {
    const op: BusyOp = { kind: 'load', slug: config.slug, label: config.name || config.slug };
    if (!begin(op)) return;
    try {
      const dto = await getConfig(config.slug);
      const result = deserializeConfigData(dto.data);
      onLoaded(result);
      onToast({
        kind: 'success',
        title: 'Workspace loaded',
        subtitle: dto.name ? `Loaded "${dto.name}"` : `Loaded config ${config.slug}`,
      });
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
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
    const op: BusyOp = { kind: 'rename', slug: config.slug, label: config.name || config.slug };
    if (!begin(op)) return;
    try {
      await updateConfig(config.slug, { name: trimmed });
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      end(op);
    }
  };

  const handleDelete = async (config: ConfigDTO) => {
    if (busyRef.current) return;
    if (!window.confirm(`Delete "${config.name || config.slug}"? This cannot be undone.`)) return;
    const op: BusyOp = { kind: 'delete', slug: config.slug, label: config.name || config.slug };
    if (!begin(op)) return;
    try {
      await deleteConfig(config.slug);
      await refresh();
    } catch (err) {
      setError(errText(err));
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
    <ComposedModal open={open} onClose={requestClose} size="lg">
      <ModalHeader title="Config store" />
      <ModalBody hasScrollingContent>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 4 }}>
          {error && (
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
                        {c.name || <em style={{ color: 'var(--cds-text-secondary)' }}>untitled</em>}
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
                            onClick={() => void handleDelete(c)}
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
  );
}
