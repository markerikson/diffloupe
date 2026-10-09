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
export function scrollToFile(groupId: string, path: string): void {
  let attempts = 0;
  const step = () => {
    const marker = fileMarker(groupId, path);
    if (!marker) return;
    const offset = marker.getBoundingClientRect().top - headerBottom();
    if (Math.abs(offset) > 2) window.scrollBy({ top: offset, behavior: "instant" });
    if (++attempts < 6 && (attempts < 2 || Math.abs(offset) > 2)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
