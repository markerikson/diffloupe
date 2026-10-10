import { headerBottom } from "./scroll-spy.ts";

export const groupElementId = (groupId: string) => `group-${groupId}`;

export function scrollToGroup(groupId: string): void {
  document.getElementById(groupElementId(groupId))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Scrolls only `container` (never the window) so `el` is inside its visible area. */
export function keepInView(container: HTMLElement, el: HTMLElement, margin = 8): void {
  const box = container.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  if (rect.top < box.top + margin) container.scrollTop -= box.top + margin - rect.top;
  else if (rect.bottom > box.bottom - margin) container.scrollTop += rect.bottom - (box.bottom - margin);
}

function fileMarker(groupId: string, path: string): HTMLElement | null {
  const section = document.getElementById(groupElementId(groupId));
  return section?.querySelector<HTMLElement>(`[data-file-start][data-path="${CSS.escape(path)}"]`) ?? null;
}

/**
 * Jumps to a file's marker. Files above the target may still be unrendered
 * placeholders whose height changes once the virtualizer draws them, so the
 * jump is repeated for a few frames until the marker settles under the header.
 */
export function scrollToFile(groupId: string, path: string, opts: { focus?: boolean } = {}): void {
  let attempts = 0;
  const step = () => {
    const marker = fileMarker(groupId, path);
    if (!marker) return;
    const offset = marker.getBoundingClientRect().top - headerBottom();
    if (Math.abs(offset) > 2) window.scrollBy({ top: offset, behavior: "instant" });
    if (++attempts < 6 && (attempts < 2 || Math.abs(offset) > 2)) requestAnimationFrame(step);
    else if (opts.focus) marker.focus({ preventScroll: true });
  };
  requestAnimationFrame(step);
}

// Room for the sticky file header plus the few diff lines the card refers to.
const CARD_MARGIN = 120;

/**
 * Brings an annotation card into view below the sticky headers and focuses it.
 * Pierre only slots annotations for lines it has rendered, so on a long file
 * the card may not be laid out yet: the page steps down through the file a
 * screen at a time until the card appears or the file ends.
 */
export function scrollToCard(groupId: string, path: string, elementId: string): void {
  let frames = 0;
  let settled = 0;
  let jumpedToFile = false;
  const step = () => {
    if (++frames > 90) return;
    const card = document.getElementById(elementId);
    if (card && card.getClientRects().length > 0) {
      const offset = card.getBoundingClientRect().top - headerBottom() - CARD_MARGIN;
      if (Math.abs(offset) > 2) {
        window.scrollBy({ top: offset, behavior: "instant" });
        settled = 0;
      } else settled++;
      if (settled < 2) requestAnimationFrame(step);
      else card.focus({ preventScroll: true });
      return;
    }
    const marker = fileMarker(groupId, path);
    if (!marker) return;
    if (!jumpedToFile) {
      jumpedToFile = true;
      window.scrollBy({ top: marker.getBoundingClientRect().top - headerBottom(), behavior: "instant" });
    } else if (frames % 3 === 0) {
      const frame = marker.nextElementSibling;
      const bottom = frame?.getBoundingClientRect().bottom ?? 0;
      if (bottom <= window.innerHeight) return;
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "instant" });
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The file whose marker is the last one at or above the sticky header line. */
export function currentFileAtTop(): { groupId: string; path: string } | null {
  const line = headerBottom() + 4;
  let found: HTMLElement | null = null;
  for (const marker of document.querySelectorAll<HTMLElement>("[data-file-start]")) {
    if (marker.getBoundingClientRect().top <= line) found = marker;
    else break;
  }
  const section = found?.closest<HTMLElement>("[data-group-section]");
  const path = found?.dataset.path;
  return section?.dataset.groupSection && path ? { groupId: section.dataset.groupSection, path } : null;
}
