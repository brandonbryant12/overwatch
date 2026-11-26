/** The page's inline SVG: health glyphs, severity glyphs and the hourly spark. Every one is decoration (aria-hidden). */
import type { Html } from "@effect/ui/html";

const Icon = <M>(h: Html.H<M>, viewBox = "0 0 16 16") => h.svg.attrs({ viewBox, "aria-hidden": "true" });
const Circle = <M>(h: Html.H<M>, dash?: string) =>
  h.circle.attrs({ cx: "8", cy: "8", r: "6.2", ...(dash === undefined ? {} : { "stroke-dasharray": dash }) });
const Path = <M>(h: Html.H<M>, d: string) => h.path.attr("d", d);

/** An environment's health, drawn. */
export const HealthGlyph = <M>(h: Html.H<M>, health: string) => {
  switch (health) {
    case "quiet":
      return Icon(h).children(Circle(h), Path(h, "M5.2 8.2l2 2 3.8-4"));
    case "attention":
      return Icon(h).children(Path(h, "M8 1.8l6.2 6.2L8 14.2 1.8 8z"), Path(h, "M8 5v3.6M8 10.6v.4"));
    case "partial":
      return Icon(h).children(Circle(h, "3 2.2"), Path(h, "M8 1.8a6.2 6.2 0 0 1 0 12.4z").class("fill"));
    case "stale":
      return Icon(h).children(Circle(h, "2 2"), Path(h, "M8 4.6V8l2.4 1.6"));
    case "signed_out":
      return Icon(h).children(Circle(h), Path(h, "M3.6 12.4l8.8-8.8"));
    default:
      return Icon(h).children(Circle(h, "2 2"), Path(h, "M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M8 11v.3"));
  }
};

/** A problem's severity, drawn; nothing for a severity the page does not know. */
export const SeverityGlyph = <M>(h: Html.H<M>, severity: string) => {
  switch (severity) {
    case "error":
      return Icon(h).children(Path(h, "M8 1.8l6.2 6.2L8 14.2 1.8 8z"), Path(h, "M8 5v3.6M8 10.6v.4"));
    case "warn":
      return Icon(h).children(Path(h, "M8 2l6.5 11.5h-13z"), Path(h, "M8 6.3v3.2M8 11.4v.3"));
    case "info":
      return Icon(h).children(Circle(h), Path(h, "M8 7.2V11M8 5v.3"));
    default:
      return null;
  }
};

/** Counts per hour as bars; an hour with none is a hairline. */
export const Spark = <M>(h: Html.H<M>, values: ReadonlyArray<number | null>, w = 72, height = 18) => {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const bw = w / values.length;
  return h.svg.class("spark").attrs({ viewBox: `0 0 ${w} ${height}`, width: String(w), height: String(height), "aria-hidden": "true" }).children(
    ...values.map((v, i) => {
      const x = (i * bw + 0.5).toFixed(1), width = (bw - 1).toFixed(1);
      if (!v) return h.rect.class("zero").attrs({ x, y: String(height - 1), width, height: "1" });
      const tall = Math.max(1.5, (v / max) * height);
      return h.rect.attrs({ x, y: (height - tall).toFixed(1), width, height: tall.toFixed(1), rx: "0.8" });
    }),
  );
};

/** The theme switch's sun. */
export const ThemeIcon = <M>(h: Html.H<M>) =>
  Icon(h, "0 0 20 20").children(
    h.circle.attrs({ cx: "10", cy: "10", r: "4" }),
    Path(h, "M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6L16 16M4 16l1.4-1.4M14.6 5.4L16 4"),
  );

/** The keyboard help's keyboard. */
export const KeyboardIcon = <M>(h: Html.H<M>) =>
  Icon(h, "0 0 20 20").children(h.rect.attrs({ x: "2", y: "5", width: "16", height: "10", rx: "2" }), Path(h, "M5 8h1M8 8h1M11 8h1M14 8h1M6 12h8"));

/** The finder's magnifier. */
export const SearchIcon = <M>(h: Html.H<M>) =>
  Icon(h, "0 0 20 20").children(h.circle.attrs({ cx: "8.5", cy: "8.5", r: "5.5" }), Path(h, "M13 13l4.5 4.5"));

/** The empty inbox's check. */
export const ClearIcon = <M>(h: Html.H<M>) =>
  Icon(h, "0 0 48 48").children(h.circle.attrs({ cx: "24", cy: "24", r: "18" }), Path(h, "M16 24.5l5.5 5.5L32.5 19"));
