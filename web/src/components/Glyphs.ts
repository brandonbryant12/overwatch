/** The page's inline SVG: health glyphs, severity glyphs, sparks, annotated timeline and crisp action icons. */
import { el, type H, type Html } from "../ui.ts";

const Icon = <M>(h: H<M>, viewBox: string, ...children: ReadonlyArray<Html>) =>
  el(h, "svg", { attrs: { viewBox, "aria-hidden": "true" } }, ...children);
const Circle = <M>(h: H<M>, dash?: string) => el(h, "circle", { attrs: { cx: "8", cy: "8", r: "6.2", "stroke-dasharray": dash } });
const Path = <M>(h: H<M>, d: string, className?: string) => el(h, "path", { class: className ?? [], attrs: { d } });

/** An environment's health, drawn. */
export const HealthGlyph = <M>(h: H<M>, health: string) => {
  switch (health) {
    case "quiet":
      return Icon(h, "0 0 16 16", Circle(h), Path(h, "M5.2 8.2l2 2 3.8-4"));
    case "attention":
      return Icon(h, "0 0 16 16", Path(h, "M8 1.8l6.2 6.2L8 14.2 1.8 8z"), Path(h, "M8 5v3.6M8 10.6v.4"));
    case "partial":
      return Icon(h, "0 0 16 16", Circle(h, "3 2.2"), Path(h, "M8 1.8a6.2 6.2 0 0 1 0 12.4z", "fill"));
    case "stale":
      return Icon(h, "0 0 16 16", Circle(h, "2 2"), Path(h, "M8 4.6V8l2.4 1.6"));
    case "signed_out":
      return Icon(h, "0 0 16 16", Circle(h), Path(h, "M3.6 12.4l8.8-8.8"));
    default:
      return Icon(h, "0 0 16 16", Circle(h, "2 2"), Path(h, "M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M8 11v.3"));
  }
};

/** A problem's severity, drawn; nothing for a severity the page does not know. */
export const SeverityGlyph = <M>(h: H<M>, severity: string) => {
  switch (severity) {
    case "error":
      return Icon(h, "0 0 16 16", Path(h, "M8 1.8l6.2 6.2L8 14.2 1.8 8z"), Path(h, "M8 5v3.6M8 10.6v.4"));
    case "warn":
      return Icon(h, "0 0 16 16", Path(h, "M8 2l6.5 11.5h-13z"), Path(h, "M8 6.3v3.2M8 11.4v.3"));
    case "info":
      return Icon(h, "0 0 16 16", Circle(h), Path(h, "M8 7.2V11M8 5v.3"));
    default:
      return null;
  }
};

/** Counts per hour as bars; an hour with none is a hairline. */
export const Spark = <M>(h: H<M>, values: ReadonlyArray<number | null>, w = 72, height = 18) => {
  const n = Math.max(1, values.length);
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const bw = w / n;
  return el(
    h,
    "svg",
    { class: "spark", attrs: { viewBox: `0 0 ${w} ${height}`, width: String(w), height: String(height), "aria-hidden": "true" } },
    ...values.map((v, i) => {
      const x = (i * bw + 0.5).toFixed(1), width = Math.max(1, bw - 1).toFixed(1);
      if (!v) return el(h, "rect", { class: "zero", attrs: { x, y: String(height - 1), width, height: "1" } });
      const tall = Math.max(1.5, (v / max) * height);
      return el(h, "rect", { attrs: { x, y: (height - tall).toFixed(1), width, height: tall.toFixed(1), rx: "0.8" } });
    }),
  );
};

/**
 * Full-width annotated 24h occurrence chart: subtle horizontal gridlines, peak readout, unmeasured gap shading,
 * per-hour native SVG tooltips, and an optional vertical dashed deploy-onset marker.
 */
export const AnnotatedSpark = <M>(
  h: H<M>,
  values: ReadonlyArray<number | null>,
  options: { readonly deploySha?: string | null; readonly onsetIndex?: number | null } = {},
) => {
  const w = 560, height = 84, topPad = 16, botPad = 6, plotH = height - topPad - botPad;
  const slots = values.length > 0 ? values : Array.from({ length: 24 }, () => 0);
  const max = Math.max(1, ...slots.map((v) => v ?? 0));
  const bw = w / slots.length;
  const onset = options.onsetIndex != null && options.onsetIndex >= 0 && options.onsetIndex < slots.length ? options.onsetIndex : null;
  const onsetX = onset !== null ? onset * bw + 0.5 : null;
  const midY = (topPad + plotH * 0.5).toFixed(1);
  const baseY = (topPad + plotH).toFixed(1);

  return el(
    h,
    "svg",
    { class: ["spark", "spark-stage"], attrs: { viewBox: `0 0 ${w} ${height}`, role: "img", "aria-label": `24-hour counts, peak ${max} per hour` } },
    // Subtle hairline gridlines (top, mid, baseline)
    el(h, "line", { class: "gridline", attrs: { x1: "0", y1: String(topPad), x2: String(w), y2: String(topPad) } }),
    el(h, "line", { class: "gridline", attrs: { x1: "0", y1: midY, x2: String(w), y2: midY } }),
    el(h, "line", { class: "baseline", attrs: { x1: "0", y1: baseY, x2: String(w), y2: baseY } }),
    // Peak annotation at top-left
    el(h, "text", { class: "peak-label", attrs: { x: "2", y: "11" } }, `peak ${max.toLocaleString("en-US")}/h`),
    // Hourly bars or unmeasured gap slots
    ...slots.map((v, i) => {
      const x = (i * bw + 1.5).toFixed(1);
      const width = Math.max(2, bw - 3).toFixed(1);
      const hoursAgo = slots.length - 1 - i;
      const when = hoursAgo === 0 ? "this hour" : `${hoursAgo}h ago`;
      if (v === null) {
        return el(
          h,
          "rect",
          { class: "gap-bar", attrs: { x, y: String(topPad), width, height: String(plotH), rx: "1.5" } },
          el(h, "title", {}, `${when}: not fully measured`),
        );
      }
      if (v === 0) {
        return el(
          h,
          "rect",
          { class: "zero", attrs: { x, y: String(topPad + plotH - 1.5), width, height: "1.5" } },
          el(h, "title", {}, `${when}: 0`),
        );
      }
      const tall = Math.max(3, (v / max) * plotH);
      return el(
        h,
        "rect",
        { class: "bar", attrs: { x, y: (topPad + plotH - tall).toFixed(1), width, height: tall.toFixed(1), rx: "2" } },
        el(h, "title", {}, `${when}: ${v.toLocaleString("en-US")}`),
      );
    }),
    // Vertical dashed deploy-onset marker
    onsetX !== null && options.deploySha
      ? el(
        h,
        "g",
        { class: "deploy-marker" },
        el(h, "line", { attrs: { x1: onsetX.toFixed(1), y1: String(topPad - 2), x2: onsetX.toFixed(1), y2: baseY, "stroke-dasharray": "3 3" } }),
        el(h, "circle", { attrs: { cx: onsetX.toFixed(1), cy: String(topPad - 2), r: "2.5" } }),
        el(
          h,
          "text",
          { attrs: { x: String(Math.min(w - 92, Math.max(76, onsetX + 5))), y: "11" } },
          `deploy ${options.deploySha.slice(0, 7)}`,
        ),
      )
      : null,
  );
};

/** The theme switch's sun. */
export const ThemeIcon = <M>(h: H<M>) =>
  Icon(
    h,
    "0 0 20 20",
    el(h, "circle", { attrs: { cx: "10", cy: "10", r: "4" } }),
    Path(h, "M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6L16 16M4 16l1.4-1.4M14.6 5.4L16 4"),
  );

/** The keyboard help's keyboard. */
export const KeyboardIcon = <M>(h: H<M>) =>
  Icon(h, "0 0 20 20", el(h, "rect", { attrs: { x: "2", y: "5", width: "16", height: "10", rx: "2" } }), Path(h, "M5 8h1M8 8h1M11 8h1M14 8h1M6 12h8"));

/** The finder's magnifier. */
export const SearchIcon = <M>(h: H<M>) =>
  Icon(h, "0 0 20 20", el(h, "circle", { attrs: { cx: "8.5", cy: "8.5", r: "5.5" } }), Path(h, "M13 13l4.5 4.5"));

/** The empty inbox's check. */
export const ClearIcon = <M>(h: H<M>) =>
  Icon(h, "0 0 48 48", el(h, "circle", { attrs: { cx: "24", cy: "24", r: "18" } }), Path(h, "M16 24.5l5.5 5.5L32.5 19"));

/** Compact document icon for Brief in topbar. */
export const BriefIcon = <M>(h: H<M>) =>
  Icon(h, "0 0 20 20", el(h, "rect", { attrs: { x: "4", y: "2.5", width: "12", height: "15", rx: "2" } }), Path(h, "M7 7h6M7 10.5h6M7 14h4"));

/** Geometric optical lens reticle icon for Visual Lens. */
export const LensIcon = <M>(h: H<M>) =>
  Icon(h, "0 0 16 16", Path(h, "M1.5 8C3.6 4.4 12.4 4.4 14.5 8c-2.1 3.6-10.9 3.6-13 0z"), Path(h, "M8 5.2L10.8 8 8 10.8 5.2 8z"));

/** Crisp copy-to-clipboard glyph for OpenCode handoff. */
export const CopyIcon = <M>(h: H<M>) =>
  Icon(h, "0 0 16 16", el(h, "rect", { attrs: { x: "5.5", y: "5.5", width: "8", height: "8", rx: "1.5" } }), Path(h, "M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7"));

/** Commit node glyph. */
export const CommitIcon = <M>(h: H<M>) =>
  Icon(h, "0 0 16 16", el(h, "circle", { attrs: { cx: "8", cy: "8", r: "2.8" } }), Path(h, "M1.5 8h3.7M10.8 8h3.7"));
