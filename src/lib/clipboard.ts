/**
 * Copy to clipboard with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is undefined over plain http (local network testing,
 * for instance), so we fall back to the deprecated `execCommand` path rather
 * than leaving the copy button dead.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path — permission denied, or no clipboard.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
