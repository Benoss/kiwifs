import type { InspectState } from "./inspect";

/**
 * Keys to mark as linked on this canvas.
 *
 * Keys that arrive from another widget through a `link:` always count. A
 * canvas's own hover or selection only counts once the page is using the
 * inspect features (`why`, `link:`, `hoverPredecessors`) — otherwise every
 * existing `onNodeClick` graph would start restyling nodes on hover.
 */
export function inspectLinked(bus: InspectState, widgetId: string, optedIn: boolean): Set<string> {
  const keys = bus.linkedKeys(widgetId);
  if (keys.size === 0) return keys;
  const source = bus.hovered ?? bus.selected;
  if (source?.widget !== widgetId) return keys;
  if (optedIn || Object.keys(bus.why).length > 0 || bus.links.length > 0) return keys;
  return new Set();
}
