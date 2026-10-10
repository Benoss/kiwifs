import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { LiveProvider, LivePreview, LiveError } from "react-live";
import yaml from "js-yaml";
import { getWidget } from "@kw/widgets/registry";
import { getFence, TypedFence } from "@kw/fences";
import { usePlayback } from "@kw/widgets/usePlayback";
import { useLocalState } from "@kw/widgets/useLocalState";
import { usePageIndex } from "@kw/widgets/usePageIndex";
import { PlaybackControls } from "@kw/widgets/PlaybackControls";
import { ArrayView, ArrayStack } from "@kw/widgets/ArrayView";
import { BitsView } from "@kw/widgets/BitsView";
import { PropertyBar } from "@kw/widgets/PropertyBar";
import { CodeHighlight } from "@kw/widgets/CodeHighlight";
import { TreeView } from "@kw/widgets/TreeView";
import { MatrixView } from "@kw/widgets/MatrixView";
import { ActivityGrid } from "@kw/widgets/ActivityGrid";
import { BarView } from "@kw/widgets/BarView";
import { PlotView } from "@kw/widgets/PlotView";
import { GraphView } from "@kw/widgets/GraphView";
import { LinkedListView } from "@kw/widgets/LinkedListView";
import { CallStackView } from "@kw/widgets/CallStackView";
import { TimelineView } from "@kw/widgets/TimelineView";
import { StackView } from "@kw/widgets/StackView";
import { TableView } from "@kw/widgets/TableView";
import { NumberLineView } from "@kw/widgets/NumberLineView";
import { PlaneView } from "@kw/widgets/PlaneView";
import { MapView } from "@kw/widgets/MapView";
import { QueueView } from "@kw/widgets/QueueView";
import { MemoryView } from "@kw/widgets/MemoryView";
import { heapTreeFromArray } from "@kw/widgets/treeLayout";
import { AnnotationBar } from "@kw/widgets/AnnotationBar";
import { WidgetLayout, WidgetPanel } from "@kw/widgets/WidgetLayout";
import { StateInspector } from "@kw/widgets/StateInspector";
import { InputPanel } from "@kw/widgets/InputPanel";
import { DateField } from "@kw/widgets/DateField";
import { groupColor } from "@kw/widgets/colors";
import { SequenceView } from "@kw/widgets/SequenceView";
import { ZoomPanel } from "@kw/widgets/ZoomPanel";
import { WidgetRootContext } from "@kw/widgets/widgetRoot";
import { PlaybackClock } from "@kw/widgets/clockContext";
import { InspectContext, useInspectState } from "@kw/widgets/inspect";
import { ErrorBoundary } from "./ErrorBoundary";
import { MermaidView } from "./MermaidView";

const liveScope = {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  usePlayback,
  useLocalState,
  usePageIndex,
  PlaybackControls,
  ArrayView,
  ArrayStack,
  BitsView,
  PropertyBar,
  CodeHighlight,
  TreeView,
  MatrixView,
  ActivityGrid,
  BarView,
  PlotView,
  GraphView,
  LinkedListView,
  CallStackView,
  TimelineView,
  StackView,
  TableView,
  NumberLineView,
  PlaneView,
  MapView,
  QueueView,
  MemoryView,
  heapTreeFromArray,
  AnnotationBar,
  WidgetLayout,
  WidgetPanel,
  StateInspector,
  InputPanel,
  DateField,
  groupColor,
  SequenceView,
  ZoomPanel,
  MermaidView,
  PlaybackClock,
};

interface Props {
  name: string;
  source: string;
  /** Fence meta string, forwarded to typed fences (`id=`, `clock=`, …). */
  meta?: string;
  onNavigate?: (path: string) => void;
}

export function KiwiWidget({ name, source, meta, onNavigate }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  // A live block gets the same inspect bus a typed fence does, so a view
  // inside it can report selections and two views can light each other up.
  const bus = useInspectState();
  if (name === "live") {
    return (
      <ErrorBoundary fallback={<WidgetError name={name} source={source} />}>
        <WidgetRootContext.Provider value={rootRef}>
          <InspectContext.Provider value={bus}>
            <div ref={rootRef} className="kiwi-widget my-4 rounded-lg border border-border overflow-hidden">
              <LiveProvider code={source} scope={liveScope} noInline>
                <div className="p-4 bg-card">
                  <LivePreview />
                </div>
                <LiveError className="px-4 py-2 text-sm font-mono text-destructive bg-destructive/10 border-t border-border whitespace-pre-wrap" />
              </LiveProvider>
            </div>
          </InspectContext.Provider>
        </WidgetRootContext.Provider>
      </ErrorBoundary>
    );
  }

  // A third-party `registerWidget` still wins, so embedders keep their own
  // name; otherwise `widget:array` resolves to exactly the spec ```array uses.
  const Widget = getWidget(name);
  if (Widget) {
    let config: Record<string, unknown> = {};
    try { config = (yaml.load(source) as Record<string, unknown>) ?? {}; } catch {}
    return (
      <ErrorBoundary fallback={<WidgetError name={name} source={source} />}>
        <Widget config={config} />
      </ErrorBoundary>
    );
  }

  const spec = getFence(name);
  if (spec) {
    return <TypedFence spec={spec} source={source} meta={meta} onNavigate={onNavigate} />;
  }

  return (
    <div className="my-4 p-4 rounded-lg border border-border bg-card">
      <p className="text-sm text-muted-foreground mb-2">
        Unknown widget: <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{name}</code>
      </p>
      <pre className="text-xs font-mono bg-muted p-3 rounded overflow-auto"><code>{source}</code></pre>
    </div>
  );
}

function WidgetError({ name, source }: { name: string; source: string }) {
  return (
    <pre className="kiwi-widget-error">
      <code>{`Widget "${name}" threw an error\n\n${source}`}</code>
    </pre>
  );
}
