/**
 * Writes text to the clipboard. Returns false when the page cannot use the
 * clipboard (not a secure context, no API, or the write was refused), so the
 * caller can show the text for manual copying instead.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window === "undefined" || !window.isSecureContext || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
