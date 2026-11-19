// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './bridges';

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'clipboard');
  });
  const setClipboard = (clip: Partial<Clipboard>) =>
    Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });

  it('uses the Clipboard API when it is allowed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await expect(copyText('TEST:A')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('TEST:A');
  });

  it('falls back to the copy command when the API is refused', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard({ writeText });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    await expect(copyText('TEST:A')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
