import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { getFence, TypedFence } from "@kw/fences";
import { ErrorBoundary } from "../ErrorBoundary";
import type { FencePreviewTarget } from "./fenceAssist";

export interface FencePreviewProps {
  /** The fence the caret is in, from `MarkdownSourceEditor`'s callback. */
  target: FencePreviewTarget | null;
}

/**
 * The picture for the fence being edited, beside the YAML.
 *
 * Mounts the same `TypedFence` the rendered page uses: a preview that goes
 * through a second code path is a preview that eventually disagrees with the
 * page. The fence's own error view does the work when the YAML is mid-edit, so
 * typing a half-finished body shows the parser's complaint rather than
 * flickering between a picture and nothing.
 */
export function FencePreview({ target }: FencePreviewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const spec = target ? getFence(target.lang) : undefined;
  if (!target || !spec) return null;

  return (
    <aside className="rounded-md border bg-card" aria-label="Widget preview">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-muted-foreground"
        aria-expanded={!collapsed}
      >
        <span>
          Preview · <code className="font-mono">{target.lang}</code>
        </span>
        {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
      </button>
      {!collapsed && (
        <div className="border-t px-2 pb-2">
          <ErrorBoundary
            fallback={
              <p className="px-2 py-3 text-xs text-destructive">
                This fence threw while rendering.
              </p>
            }
          >
            {/* Keyed on the source so a structural edit remounts rather than
                trying to reconcile a half-typed tree. */}
            <TypedFence
              key={`${target.lang}:${target.body.length}`}
              spec={spec}
              source={target.body}
              meta={target.meta}
            />
          </ErrorBoundary>
        </div>
      )}
    </aside>
  );
}
