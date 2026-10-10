/**
 * The one renderer behind every typed fence.
 *
 * It owns the "sandwich" that `kiwi-steps` used to own alone: canvas, then the
 * step note, then the code listing in lockstep, then the transport. Every
 * fence therefore gets playback, deep links, inspect and accessible names
 * without a spec having to ask for any of them.
 */

import { Suspense, useMemo, useRef, useSyncExternalStore } from "react";
import { usePlayback } from "@kw/widgets/usePlayback";
import { PlaybackControls } from "@kw/widgets/PlaybackControls";
import { AnnotationBar } from "@kw/widgets/AnnotationBar";
import { CodeHighlight } from "@kw/widgets/CodeHighlight";
import { WidgetRootContext } from "@kw/widgets/widgetRoot";
import { InspectContext, parseLinks, useInspectState, whyFor } from "@kw/widgets/inspect";
import { WidgetLayout, WidgetPanel } from "@kw/widgets/WidgetLayout";
import { ErrorBoundary } from "@kw/components/ErrorBoundary";
import { figureClassName } from "@kw/lib/figureLayout";
import { pageVars, referencedVars, subscribePageVars, substitutePageVars } from "@kw/lib/pageVars";
import { parseFence } from "./parseFence";
import { parseFenceMeta } from "./meta";
import type { FencePanel, FenceSpec } from "./registry";

export interface TypedFenceProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec: FenceSpec<any>;
  source: string;
  meta?: string;
  onNavigate?: (path: string) => void;
}

export function TypedFence({ spec, source, meta, onNavigate }: TypedFenceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const fenceMeta = useMemo(() => parseFenceMeta(meta), [meta]);
  // A fence can read a page variable a reader is dragging: `values: [1, $n]`.
  // Substituted into the YAML text rather than the parsed tree, because a
  // placeholder has to be able to stand where a number does.
  const vars = useSyncExternalStore(subscribePageVars, pageVars, pageVars);
  const referenced = useMemo(() => referencedVars(source), [source]);
  const bound = useMemo(
    () => Object.fromEntries(referenced.filter((n) => n in vars).map((n) => [n, vars[n]!])),
    [referenced, vars],
  );
  const resolvedSource = useMemo(() => substitutePageVars(source, bound), [source, bound]);

  const parsed = useMemo(() => {
    const raw = parseFence(spec, resolvedSource);
    return spec.prepare ? spec.prepare(raw) : raw;
  }, [spec, resolvedSource]);

  const steps = useMemo(
    () =>
      parsed.stepMeta.map((m, i) => ({
        state: i,
        label: m.label ?? m.note ?? "",
        breakpoint: m.breakpoint,
        duration: m.duration,
      })),
    [parsed.stepMeta],
  );

  const hasSteps = steps.length > 0;
  const pb = usePlayback(hasSteps ? steps : [{ state: 0, label: "" }], {
    containerRef: rootRef,
    clock: fenceMeta.clock,
    autoPlay: fenceMeta.autoplay,
    loop: fenceMeta.loop,
  });

  const stepIndex = hasSteps ? Math.min(pb.currentStep, steps.length - 1) : -1;
  const stepMeta = stepIndex >= 0 ? parsed.stepMeta[stepIndex] : undefined;
  const props = stepIndex >= 0 ? parsed.steps[stepIndex]! : parsed.base;

  const why = useMemo(
    () => ({ ...(parsed.why ?? {}), ...(stepMeta?.why ?? {}) }),
    [parsed.why, stepMeta?.why],
  );
  const links = useMemo(() => parseLinks(parsed.link), [parsed.link]);
  const bus = useInspectState({ why, links });

  /**
   * A step with `expect: {select: "3"}` is a question, not a frame: playback
   * holds until the reader selects that part. The JSAV "constructing" level,
   * done as data — grading on the key, never on a colour.
   */
  const expected = stepMeta?.expect?.select;
  const awaiting =
    expected !== undefined && String(bus.selected?.key ?? "") !== String(expected);

  const errors = parsed.issues.filter((i) => i.severity === "error");
  if (parsed.error || errors.length > 0) {
    return <FenceError spec={spec} source={source} message={parsed.error} issues={parsed.issues} />;
  }

  const widgetId = fenceMeta.id || spec.lang;
  const withNav = spec.needsNavigate ? { ...props, onNavigate } : props;
  const panels: FencePanel[] = spec.panels
    ? spec.panels(withNav)
    : [
        {
          key: widgetId,
          component: spec.component,
          props: spec.normalize ? spec.normalize(withNav) : withNav,
        },
      ];

  const selectedWhy = whyFor(why, bus.selected);
  const warnings = parsed.issues.filter((i) => i.severity === "warning");
  const caption = fenceMeta.caption ?? parsed.caption;
  const title = fenceMeta.title ?? parsed.title;

  return (
    <ErrorBoundary fallback={<FenceError spec={spec} source={source} message="the widget threw while rendering" issues={[]} />}>
      <WidgetRootContext.Provider value={rootRef}>
        <InspectContext.Provider value={bus}>
          <figure
            ref={rootRef}
            className={`kiwi-widget kiwi-fence rounded-lg border border-border bg-card overflow-hidden ${figureClassName({ width: fenceMeta.width, pin: false })}`}
            id={fenceMeta.id}
            tabIndex={-1}
          >
            {title && (
              <div className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {title}
              </div>
            )}
            <div className="p-4" onClick={() => bus.select(null)}>
              <Suspense fallback={<div className="h-24 animate-pulse rounded bg-muted" />}>
                {panels.length === 1 ? (
                  <Panel panel={panels[0]!} />
                ) : (
                  <WidgetLayout>
                    {panels.map((panel) => (
                      <WidgetPanel key={panel.key} title={panel.label}>
                        <Panel panel={panel} />
                      </WidgetPanel>
                    ))}
                  </WidgetLayout>
                )}
              </Suspense>

              {stepMeta?.note && (
                <AnnotationBar text={stepMeta.note} label={`Step ${stepIndex + 1}`} />
              )}

              {selectedWhy && (
                <AnnotationBar
                  text={selectedWhy}
                  label={`${bus.selected!.key}${stepIndex >= 0 ? ` · step ${stepIndex + 1}` : ""}`}
                  variant="info"
                />
              )}

              {parsed.code && (
                <CodeHighlight
                  code={parsed.code}
                  lang={parsed.lang || "text"}
                  indexBase={1}
                  activeLine={stepMeta?.line}
                  nextLine={stepMeta?.next}
                />
              )}

              {awaiting && (
                <AnnotationBar
                  text={
                    typeof stepMeta?.expect?.prompt === "string"
                      ? stepMeta.expect.prompt
                      : "Select the part this step is about to continue."
                  }
                  label="Your turn"
                  variant="warning"
                />
              )}

              {hasSteps && (
                <div className="mt-3">
                  <PlaybackControls
                    pb={pb}
                    snapshot={{ root: rootRef, name: fenceMeta.id || spec.lang }}
                    blocked={awaiting}
                  />
                </div>
              )}
            </div>

            {caption && (
              <figcaption className="border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                {caption}
              </figcaption>
            )}

            {warnings.length > 0 && (
              <div className="border-t border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-600 dark:text-amber-400">
                {warnings.map((w, i) => (
                  <div key={i}>
                    {w.line ? `line ${w.line}: ` : ""}
                    {w.message}
                  </div>
                ))}
              </div>
            )}
          </figure>
        </InspectContext.Provider>
      </WidgetRootContext.Provider>
    </ErrorBoundary>
  );
}

function Panel({ panel }: { panel: FencePanel }) {
  const Component = panel.component;
  return <Component {...panel.props} />;
}

/**
 * A broken fence shows its own source. An author staring at "invalid widget"
 * with the YAML hidden has nothing to fix.
 */
function FenceError({
  spec,
  source,
  message,
  issues,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec: FenceSpec<any>;
  source: string;
  message?: string;
  issues: { path: string; message: string; line?: number }[];
}) {
  return (
    <div className="my-4 rounded-lg border border-destructive/30 bg-destructive/5 overflow-hidden">
      <div className="px-4 py-2 text-sm font-medium text-destructive">
        <code className="font-mono text-xs">{spec.lang}</code> fence could not be rendered
      </div>
      <ul className="px-4 pb-2 text-xs text-destructive/90 space-y-0.5">
        {message && <li>{message}</li>}
        {issues.map((issue, i) => (
          <li key={i}>
            {issue.line ? `line ${issue.line}: ` : ""}
            {issue.message}
          </li>
        ))}
      </ul>
      <pre className="overflow-auto bg-muted px-4 py-3 text-xs font-mono">
        <code>{source}</code>
      </pre>
    </div>
  );
}
