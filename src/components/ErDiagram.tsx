import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type EdgeTypes,
  Handle,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { toPng } from "html-to-image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ErSchema, type ErTable, erSchema } from "@/lib/tauri";

type Props = {
  connectionId: string;
  database: string;
};

const COLUMN_ROW_HEIGHT = 22;
const HEADER_HEIGHT = 32;
const NODE_WIDTH = 240;
const NODE_PADDING = 0;

type TableNodeData = { table: ErTable; highlight: boolean };

function tableHeight(table: ErTable): number {
  return HEADER_HEIGHT + table.columns.length * COLUMN_ROW_HEIGHT + NODE_PADDING;
}

function layout(tables: ErTable[], edges: Edge[]): Node<TableNodeData>[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    ranksep: 120,
    nodesep: 40,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const t of tables) {
    g.setNode(t.name, { width: NODE_WIDTH, height: tableHeight(t) });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return tables.map((t) => {
    const n = g.node(t.name);
    return {
      id: t.name,
      type: "table",
      position: { x: n.x - NODE_WIDTH / 2, y: n.y - tableHeight(t) / 2 },
      data: { table: t, highlight: false },
    } satisfies Node<TableNodeData>;
  });
}

function TableNode({ data, selected }: NodeProps<Node<TableNodeData>>) {
  const { table, highlight } = data;
  return (
    <div
      className={`overflow-hidden rounded-md border bg-card font-mono text-[0.72rem] shadow-[0_10px_30px_-10px_oklch(0_0_0/70%)] ${
        selected || highlight
          ? "border-accent shadow-[0_0_0_2px_var(--accent-glow)]"
          : "border-border"
      }`}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div
        className="flex items-center justify-between border-b border-border bg-sidebar/60 px-2"
        style={{ height: HEADER_HEIGHT, fontFamily: "var(--font-display)" }}
      >
        <span className="truncate text-[0.85rem] font-medium tracking-tight">{table.name}</span>
        <span className="tp-num text-[0.6rem] text-muted-foreground/70">
          {table.columns.length}
        </span>
      </div>
      <ul>
        {table.columns.map((c) => (
          <li
            key={c.name}
            className="flex items-center justify-between gap-2 border-b border-border/30 px-2"
            style={{ height: COLUMN_ROW_HEIGHT }}
          >
            <span className="flex min-w-0 items-center gap-1">
              {c.is_pk && <span className="shrink-0 tp-chip-accent text-[0.55rem]">pk</span>}
              <span className="truncate">{c.name}</span>
            </span>
            <span className="truncate text-[0.6rem] text-chart-3">{c.data_type}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const nodeTypes: NodeTypes = { table: TableNode };
const edgeTypes: EdgeTypes = {};

function buildEdges(schema: ErSchema): Edge[] {
  return schema.foreign_keys.map((fk, idx) => ({
    id: `${fk.constraint}-${idx}`,
    source: fk.src_table,
    target: fk.ref_table,
    label: fk.src_columns.join(", "),
    type: "smoothstep",
    animated: false,
    style: { stroke: "var(--accent)", strokeWidth: 1.25 },
    labelStyle: {
      fill: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)",
      fontSize: 10,
    },
    labelBgStyle: { fill: "var(--card)" },
    labelBgPadding: [4, 2],
  }));
}

function ErDiagramInner({ connectionId, database }: Props) {
  const [schema, setSchema] = useState<ErSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    erSchema(connectionId, database)
      .then((s) => {
        if (!cancelled) setSchema(s);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, database]);

  const edges = useMemo(() => (schema ? buildEdges(schema) : []), [schema]);
  // tick を使って手動再レイアウトを引き起こす (依存として使う)
  const nodes = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    tick;
    return schema ? layout(schema.tables, edges) : [];
  }, [schema, edges, tick]);

  const onExportPng = useCallback(async () => {
    const el = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
    if (!el) return;
    try {
      const dataUrl = await toPng(el, {
        backgroundColor: "oklch(0.18 0.012 245)",
        pixelRatio: 2,
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${database}-er.png`;
      a.click();
    } catch (e) {
      setError(`Export failed: ${String(e)}`);
    }
  }, [database]);

  const onRelayout = useCallback(() => {
    setTick((n) => n + 1);
    window.setTimeout(() => rf.fitView({ padding: 0.2 }), 50);
  }, [rf]);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-10 items-center justify-between border-b border-border bg-sidebar/25 px-4 text-xs">
        <div className="flex items-center gap-2">
          <span className="tp-section-title">ER</span>
          <span className="font-mono text-[0.7rem] text-muted-foreground">{database}</span>
          {schema && (
            <>
              <span className="tp-chip-ghost">
                <span className="tp-num">{schema.tables.length}</span>
                <span className="ml-0.5">tables</span>
              </span>
              <span className="tp-chip-ghost">
                <span className="tp-num">{schema.foreign_keys.length}</span>
                <span className="ml-0.5">fks</span>
              </span>
            </>
          )}
          {loading && <span className="text-muted-foreground">Loading…</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onRelayout}
            disabled={!schema}
            className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.7rem] text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent disabled:opacity-50"
          >
            Relayout
          </button>
          <button
            type="button"
            onClick={onExportPng}
            disabled={!schema}
            className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.7rem] text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent disabled:opacity-50"
          >
            Export PNG
          </button>
        </div>
      </header>
      {error && (
        <p className="m-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.15}
          maxZoom={2.5}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

export function ErDiagram(props: Props) {
  return (
    <ReactFlowProvider>
      <ErDiagramInner {...props} />
    </ReactFlowProvider>
  );
}
