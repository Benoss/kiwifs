export {
  registerWidget,
  unregisterWidget,
  getWidget,
  getRegisteredWidgets,
  clearWidgets,
} from "./registry";
export type { WidgetComponent, WidgetProps } from "./registry";
export {
  usePlayback,
  type Step,
  type PlaybackReturn,
  type PlaybackOptions,
  type PlaybackControlsBinding,
} from "./usePlayback";
export { WidgetRootContext } from "./widgetRoot";
export {
  PlaybackClock,
  PlaybackClockProvider,
  useClockId,
  type PlaybackClockProps,
} from "./clockContext";
export {
  clockSnapshot,
  clockStepLink,
  seekClock,
  setClockPlaying,
  setClockSpeed,
  type ClockSnapshot,
} from "./playbackClock";
export {
  InspectContext,
  useInspect,
  useInspectState,
  parseLinks,
  partHandlers,
  refEquals,
  whyFor,
  toKeySet,
  type InspectRef,
  type InspectKind,
  type InspectLink,
  type InspectState,
  type InspectableProps,
} from "./inspect";
export { assignLanes as packLanes, laneCount, type Span } from "./lanes";
export {
  canvasAria,
  sentence,
  summarizeArray,
  summarizeArrayStack,
  summarizeBars,
  summarizeBits,
  summarizeGraph,
  summarizeLinkedList,
  summarizeMap,
  summarizeMatrix,
  summarizeNumberLine,
  summarizePlane,
  summarizePlot,
  summarizeSequence,
  summarizeStack,
  summarizeTable,
  summarizeTimeline,
  summarizeTree,
} from "./widgetA11y";
export { toSet, toCellSet, cellKey, type Many, type ManyCells, type CellRef } from "./sets";
export { useLocalState, type LocalStateResult } from "./useLocalState";
export {
  usePageIndex,
  type PageIndexResult,
  type PageIndexEntry,
  type PageIndexOptions,
} from "./usePageIndex";
export { useTweenedPositions, type Point } from "./useTweenedPositions";
export { groupColor, GROUP_COLOR_COUNT, type KeyedValues } from "./colors";
export { PlaybackControls } from "./PlaybackControls";
export {
  ArrayView,
  ArrayStack,
  type ArrayViewProps,
  type ArrayStackProps,
  type ArrayRowProps,
  type ArrayPointer,
  type ArrayArrow,
  type ArrayRange,
  type ArrayStackArrow,
} from "./ArrayView";
export { BitsView, type BitsViewProps } from "./BitsView";
export {
  decodeBits,
  fieldValue,
  toggleBit,
  asUint,
  asTwos,
  asFloat,
  type BitField,
  type BitsDecoding,
  type DecodedBits,
} from "./bitsDecode";
export { PropertyBar, type PropertyBarProps, type PropertyEntry } from "./PropertyBar";
export { CodeHighlight, type CodeHighlightProps } from "./CodeHighlight";
export { TreeView, type TreeViewProps, type TreeNode } from "./TreeView";
export {
  heapTreeFromArray,
  forestFromParents,
  childAnchorX,
  nodeWidth,
  type HeapTreeOptions,
  type LayoutInput,
  type LayoutNode,
} from "./treeLayout";
export { MatrixView, type MatrixViewProps, type MatrixArrow, type MatrixLayer } from "./MatrixView";
export { WidgetText, SvgLabel, type WidgetTextProps, type SvgLabelProps } from "./WidgetText";
export {
  headerGutterPx,
  mathSource,
  labelSegments,
  hasMath,
  type LabelSegment,
} from "./widgetLabel";
export { ActivityGrid, type ActivityGridProps } from "./ActivityGrid";
export {
  BarView,
  binSamples,
  type BarViewProps,
  type BarBinning,
  type BarPointer,
  type BarOverlay,
  type BarGuide,
} from "./BarView";
export {
  PlotView,
  type PlotViewProps,
  type PlotRegion,
  type PlotSeries,
  type PlotSeriesKind,
  type PlotPoint,
  type PlotGuide,
  type PlotShade,
  type PlotMark,
} from "./PlotView";
export { type PlotDomain, sampleSeries, sampleRegion, niceTicks, expandRange } from "./plotLayout";
export {
  GraphView,
  edgeKey,
  type GraphViewProps,
  type GraphNode,
  type GraphEdge,
  type GraphGroup,
  type GraphPacket,
} from "./GraphView";
export { type GraphLayout, type GraphDirection } from "./graphLayout";
export { type NodeShape, NODE_SHAPES } from "./graphGeometry";
export {
  SequenceView,
  type SequenceViewProps,
  type SequenceParticipant,
  type SequenceItem,
  type SequenceMessage,
  type SequenceNote,
  type SequenceDivider,
  type SequenceFrame,
} from "./SequenceView";
export { ZoomPanel, type ZoomPanelProps } from "./ZoomPanel";
export { useFlowProgress } from "./useFlowProgress";
export {
  LinkedListView,
  type LinkedListViewProps,
  type LLNode,
  type LinkedListPointer,
  type LinkedListEdge,
} from "./LinkedListView";
export { CallStackView, type CallStackViewProps, type CallFrame } from "./CallStackView";
export {
  TimelineView,
  assignLanes,
  type TimelineViewProps,
  type TimelineInterval,
  type TimelineMark,
  type TimelineLink,
} from "./TimelineView";
export { StackView, type StackViewProps, type StackPointer } from "./StackView";
export {
  TableView,
  type TableViewProps,
  type TableColumn,
  type TableArrow,
} from "./TableView";
export {
  NumberLineView,
  type NumberLineViewProps,
  type NumberLinePoint,
  type NumberLineInterval,
  type NumberLineRay,
  type NumberLineMark,
  type NumberLinePointer,
  type PointStyle,
} from "./NumberLineView";
export {
  PlaneView,
  type PlaneViewProps,
  type PlanePoint,
  type PlaneSegment,
  type PlanePolygon,
  type PlaneCircle,
  type PlaneVector,
  type PlaneLabel,
  type PlaneSweep,
  type PointRef,
  type XY,
} from "./PlaneView";
export { MapView, type MapViewProps, type MapEntry, type MapSlot } from "./MapView";
export { QueueView, type QueueViewProps, type QueuePointer } from "./QueueView";
export { AnnotationBar, type AnnotationBarProps } from "./AnnotationBar";
export { WidgetLayout, WidgetPanel, type WidgetLayoutProps, type WidgetPanelProps } from "./WidgetLayout";
export { StateInspector, type StateInspectorProps } from "./StateInspector";
export { InputPanel, type InputPanelProps, type InputField } from "./InputPanel";
export { DateField, type DateFieldProps } from "./DateField";
export { CodeRunner } from "./CodeRunner";
