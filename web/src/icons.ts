/**
 * Inline SVG brand mark, geometric wordmark, and semantic glyphs for Overwatch.
 * Zero external icon fonts, zero raster assets, zero runtime network calls.
 */
import type { Html, HtmlBuilder } from "foldkit/html";

type H<M> = HtmlBuilder<M>;

/** The Overwatch Sentinel Reticle mark: chamfered octagonal housing, optical aperture, and signal-amber reticle core. */
export function logoMark<M>(h: H<M>, size = 28): Html {
  return h.svg(
    [
      h.Class("ow-mark"),
      h.ViewBox("0 0 64 64"),
      h.Width(String(size)),
      h.Height(String(size)),
      h.AriaHidden(true),
    ],
    [
      h.path([h.Class("ow-mark-housing"), h.D("M19 3 H45 L61 19 V45 L45 61 H19 L3 45 V19 Z")]),
      h.path([h.Class("ow-mark-arc"), h.D("M16 18 A22 22 0 0 1 48 18")]),
      h.path([h.Class("ow-mark-arc"), h.D("M48 46 A22 22 0 0 1 16 46")]),
      h.path([h.Class("ow-mark-ticks"), h.D("M32 7.5 V12.5 M32 51.5 V56.5 M7.5 32 H12.5 M51.5 32 H56.5")]),
      h.path([h.Class("ow-mark-aperture"), h.D("M11 32 C19.5 18 44.5 18 53 32 C44.5 46 19.5 46 11 32 Z")]),
      h.path([h.Class("ow-mark-core"), h.D("M32 21.5 L42.5 32 L32 42.5 L21.5 32 Z")]),
      h.path([h.Class("ow-mark-cross"), h.D("M32 21.5 V25.5 M32 38.5 V42.5 M21.5 32 H25.5 M38.5 32 H42.5")]),
      h.circle([h.Class("ow-mark-pinhole"), h.Cx("32"), h.Cy("32"), h.R("3.2")]),
      h.circle([h.Class("ow-mark-glint"), h.Cx("32"), h.Cy("32"), h.R("1.1")]),
    ],
  );
}

/** Hand-authored geometric SVG wordmark (pure paths, no font dependency). */
export function logoWordmark<M>(h: H<M>): Html {
  return h.svg(
    [h.Class("ow-wordmark"), h.ViewBox("0 -2 300 36"), h.Width("136"), h.Height("16"), h.AriaHidden(true)],
    [
      h.g(
        [h.Class("ow-wordmark-paths"), h.Transform("translate(2 2)")],
        [
          h.path([h.D("M6 0 H18 L24 6 V22 L18 28 H6 L0 22 V6 Z")]),
          h.path([h.D("M33 0 L44 28 L55 0")]),
          h.path([h.D("M84 0 H64 V28 H84 M64 14 H80")]),
          h.path([h.D("M94 28 V0 H110 L116 6 V11 L110 16 H94 M107 16 L117 28")]),
          h.path([h.D("M126 0 L132 28 L140 10 L148 28 L154 0")]),
          h.path([h.D("M163 28 L174 0 L185 28 M167 19 H181")]),
          h.path([h.D("M192 0 H216 M204 0 V28")]),
          h.path([h.D("M246 6 L240 0 H228 L222 6 V22 L228 28 H240 L246 22")]),
          h.path([h.D("M256 0 V28 M278 0 V28 M256 14 H278")]),
        ],
      ),
      h.path([h.Class("ow-wordmark-dot"), h.D("M290 21 L295 26 L290 31 L285 26 Z")]),
    ],
  );
}

function glyph<M>(h: H<M>, cls: string, children: ReadonlyArray<Html>, size = 15): Html {
  return h.svg(
    [h.Class(`icon ${cls}`), h.ViewBox("0 0 16 16"), h.Width(String(size)), h.Height(String(size)), h.Fill("none"), h.AriaHidden(true)],
    children,
  );
}

/** Severity & semantic state icons — every state has a unique shape, never colour alone. */
export const iconSeverity = <M>(h: H<M>, severity: string): Html => {
  if (severity === "error") {
    // Filled chamfered diamond with exclamation
    return glyph(h, "icon-error", [
      h.path([h.D("M8 1.4 L14.6 8 L8 14.6 L1.4 8 Z"), h.Fill("currentColor"), h.FillOpacity("0.18"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinejoin("round")]),
      h.path([h.D("M8 4.8 V8.5 M8 10.9 V11.3"), h.Stroke("currentColor"), h.StrokeWidth("1.6"), h.StrokeLinecap("round")]),
    ]);
  }
  if (severity === "warn") {
    // Upward triangle with bar
    return glyph(h, "icon-warn", [
      h.path([h.D("M8 2 L14.5 13.5 H1.5 Z"), h.Fill("currentColor"), h.FillOpacity("0.16"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinejoin("round")]),
      h.path([h.D("M8 6 V9.2 M8 11.4 V11.7"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round")]),
    ]);
  }
  // Info: circle with dot-stem
  return glyph(h, "icon-info", [
    h.circle([h.Cx("8"), h.Cy("8"), h.R("6"), h.Stroke("currentColor"), h.StrokeWidth("1.5")]),
    h.path([h.D("M8 7.3 V11 M8 5 V5.3"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round")]),
  ]);
};

export const iconVerified = <M>(h: H<M>): Html =>
  glyph(h, "icon-verified", [
    h.circle([h.Cx("8"), h.Cy("8"), h.R("6.2"), h.Fill("currentColor"), h.FillOpacity("0.16"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M5.2 8.2 L7.1 10.1 L10.9 6.1"), h.Stroke("currentColor"), h.StrokeWidth("1.6"), h.StrokeLinecap("round"), h.StrokeLinejoin("round")]),
  ]);

export const iconUnverified = <M>(h: H<M>): Html =>
  glyph(h, "icon-unverified", [
    h.circle([h.Cx("8"), h.Cy("8"), h.R("6.2"), h.Stroke("currentColor"), h.StrokeWidth("1.4"), h.StrokeDasharray("2.4 2.1")]),
    h.path([h.D("M6.4 6.2 C6.4 5.2 7.1 4.6 8.1 4.6 C9.1 4.6 9.8 5.2 9.8 6.1 C9.8 7 8.9 7.4 8.3 7.9 C8 8.2 8 8.5 8 9 M8 11.2 V11.5"), h.Stroke("currentColor"), h.StrokeWidth("1.45"), h.StrokeLinecap("round")]),
  ]);

export const iconPromptStatus = <M>(h: H<M>, status: string): Html => {
  switch (status) {
    case "answered":
      return iconVerified(h);
    case "sent":
      return glyph(h, "icon-active", [
        h.circle([h.Cx("8"), h.Cy("8"), h.R("6"), h.Stroke("currentColor"), h.StrokeWidth("1.4"), h.StrokeDasharray("10 6")]),
        h.circle([h.Cx("8"), h.Cy("8"), h.R("2.2"), h.Fill("currentColor")]),
      ]);
    case "queued":
      return glyph(h, "icon-queued", [
        h.circle([h.Cx("8"), h.Cy("8"), h.R("6"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
        h.path([h.D("M8 4.8 V8.2 L10.5 9.6"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round"), h.StrokeLinejoin("round")]),
      ]);
    case "failed":
      return glyph(h, "icon-failed", [
        h.path([h.D("M5.2 1.8 H10.8 L14.2 5.2 V10.8 L10.8 14.2 H5.2 L1.8 10.8 V5.2 Z"), h.Fill("currentColor"), h.FillOpacity("0.15"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
        h.path([h.D("M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round")]),
      ]);
    default: // held
      return glyph(h, "icon-held", [
        h.circle([h.Cx("8"), h.Cy("8"), h.R("6"), h.Stroke("currentColor"), h.StrokeWidth("1.4"), h.StrokeDasharray("2.6 2")]),
        h.path([h.D("M6.4 5.5 V10.5 M9.6 5.5 V10.5"), h.Stroke("currentColor"), h.StrokeWidth("1.6"), h.StrokeLinecap("round")]),
      ]);
  }
};

export const iconOffline = <M>(h: H<M>): Html =>
  glyph(h, "icon-offline", [
    h.circle([h.Cx("8"), h.Cy("8"), h.R("6"), h.Stroke("currentColor"), h.StrokeWidth("1.45")]),
    h.path([h.D("M3.8 12.2 L12.2 3.8"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round")]),
  ]);

export const iconLive = <M>(h: H<M>): Html =>
  glyph(h, "icon-live", [
    h.circle([h.Cx("8"), h.Cy("8"), h.R("3"), h.Fill("currentColor")]),
    h.circle([h.Cx("8"), h.Cy("8"), h.R("6.2"), h.Stroke("currentColor"), h.StrokeWidth("1.3"), h.Opacity("0.45")]),
  ]);

export const iconArchive = <M>(h: H<M>): Html =>
  glyph(h, "icon-archive", [
    h.rect([h.X("2"), h.Y("2.5"), h.Width("12"), h.Height("3"), h.Rx("1"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M3.2 5.5 V12.5 C3.2 13.1 3.7 13.5 4.2 13.5 H11.8 C12.3 13.5 12.8 13.1 12.8 12.5 V5.5"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M6.4 8.8 H9.6"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round")]),
  ]);

export const iconSearch = <M>(h: H<M>): Html =>
  glyph(h, "icon-search", [
    h.circle([h.Cx("7.2"), h.Cy("7.2"), h.R("4.8"), h.Stroke("currentColor"), h.StrokeWidth("1.5")]),
    h.path([h.D("M10.9 10.9 L14 14"), h.Stroke("currentColor"), h.StrokeWidth("1.6"), h.StrokeLinecap("round")]),
  ]);

export const iconReticle = <M>(h: H<M>): Html =>
  glyph(h, "icon-reticle", [
    h.circle([h.Cx("8"), h.Cy("8"), h.R("4.4"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M8 1.5 V3.6 M8 12.4 V14.5 M1.5 8 H3.6 M12.4 8 H14.5"), h.Stroke("currentColor"), h.StrokeWidth("1.4"), h.StrokeLinecap("round")]),
    h.circle([h.Cx("8"), h.Cy("8"), h.R("1.3"), h.Fill("currentColor")]),
  ]);

export const iconSend = <M>(h: H<M>): Html =>
  glyph(h, "icon-send", [
    h.path([h.D("M2.2 8 H13.2 M9.4 4.2 L13.4 8 L9.4 11.8"), h.Stroke("currentColor"), h.StrokeWidth("1.6"), h.StrokeLinecap("round"), h.StrokeLinejoin("round")]),
  ]);

export const iconSun = <M>(h: H<M>): Html =>
  glyph(h, "icon-sun", [
    h.circle([h.Cx("8"), h.Cy("8"), h.R("3"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M8 1.8 V3.2 M8 12.8 V14.2 M1.8 8 H3.2 M12.8 8 H14.2 M3.6 3.6 L4.6 4.6 M11.4 11.4 L12.4 12.4 M12.4 3.6 L11.4 4.6 M4.6 11.4 L3.6 12.4"), h.Stroke("currentColor"), h.StrokeWidth("1.4"), h.StrokeLinecap("round")]),
  ]);

export const iconMoon = <M>(h: H<M>): Html =>
  glyph(h, "icon-moon", [
    h.path([h.D("M12.6 10.2 A5.5 5.5 0 0 1 5.8 3.4 A5.6 5.6 0 1 0 12.6 10.2 Z"), h.Stroke("currentColor"), h.StrokeWidth("1.4"), h.StrokeLinejoin("round")]),
  ]);

export const iconKeyboard = <M>(h: H<M>): Html =>
  glyph(h, "icon-keyboard", [
    h.rect([h.X("1.5"), h.Y("3.5"), h.Width("13"), h.Height("9"), h.Rx("1.8"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M4.2 6.5 H5.2 M7.5 6.5 H8.5 M10.8 6.5 H11.8 M5 9.8 H11"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round")]),
  ]);

export const iconClose = <M>(h: H<M>): Html =>
  glyph(h, "icon-close", [
    h.path([h.D("M4 4 L12 12 M12 4 L4 12"), h.Stroke("currentColor"), h.StrokeWidth("1.6"), h.StrokeLinecap("round")]),
  ]);

export const iconCopy = <M>(h: H<M>): Html =>
  glyph(h, "icon-copy", [
    h.rect([h.X("5.5"), h.Y("5.5"), h.Width("8"), h.Height("8"), h.Rx("1.4"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M3.5 10.5 H3 C2.4 10.5 2 10.1 2 9.5 V3 C2 2.4 2.4 2 3 2 H9.5 C10.1 2 10.5 2.4 10.5 3 V3.5"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
  ]);

export const iconTerminal = <M>(h: H<M>): Html =>
  glyph(h, "icon-terminal", [
    h.rect([h.X("1.8"), h.Y("2.6"), h.Width("12.4"), h.Height("10.8"), h.Rx("1.8"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M4.5 6.2 L6.8 8.2 L4.5 10.2 M8.2 10.2 H11.5"), h.Stroke("currentColor"), h.StrokeWidth("1.45"), h.StrokeLinecap("round"), h.StrokeLinejoin("round")]),
  ]);

/** Done: a check, plain. */
export const iconDone = <M>(h: H<M>): Html =>
  glyph(h, "icon-done", [
    h.path([h.D("M3.2 8.4 L6.6 11.6 L12.8 4.6"), h.Stroke("currentColor"), h.StrokeWidth("1.7"), h.StrokeLinecap("round"), h.StrokeLinejoin("round")]),
  ]);

/** Later: a clock. */
export const iconLater = <M>(h: H<M>): Html =>
  glyph(h, "icon-later", [
    h.circle([h.Cx("8"), h.Cy("8"), h.R("6"), h.Stroke("currentColor"), h.StrokeWidth("1.4")]),
    h.path([h.D("M8 4.6 V8.2 L10.4 9.6"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round"), h.StrokeLinejoin("round")]),
  ]);

/** Never: a bell struck through. */
export const iconNever = <M>(h: H<M>): Html =>
  glyph(h, "icon-never", [
    h.path([h.D("M4.4 11 V7.6 C4.4 5.6 6 4 8 4 C10 4 11.6 5.6 11.6 7.6 V11 L12.6 12 H3.4 Z"), h.Stroke("currentColor"), h.StrokeWidth("1.35"), h.StrokeLinejoin("round")]),
    h.path([h.D("M6.8 13.6 H9.2"), h.Stroke("currentColor"), h.StrokeWidth("1.35"), h.StrokeLinecap("round")]),
    h.path([h.D("M2.6 2.6 L13.4 13.4"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round")]),
  ]);

/** Undo: an arrow turning back. */
export const iconUndo = <M>(h: H<M>): Html =>
  glyph(h, "icon-undo", [
    h.path([h.D("M5.6 3.6 L2.8 6.4 L5.6 9.2"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round"), h.StrokeLinejoin("round")]),
    h.path([h.D("M3 6.4 H9.6 C11.6 6.4 13.2 8 13.2 10 C13.2 12 11.6 13.4 9.6 13.4 H7"), h.Stroke("currentColor"), h.StrokeWidth("1.5"), h.StrokeLinecap("round")]),
  ]);
