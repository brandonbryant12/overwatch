#![forbid(unsafe_code)]

//! Custom GPU-rendered instrumentation primitives for Overwatch built on Anomaly Rune:
//! - Precision Instrument Alabaster & Obsidian color tokens
//! - Latency / CPU / Memory sparklines with rollout baseline threshold markers
//! - Kubernetes `usage / request / limit` resource utilization bars

use rune::{Color, El, col, el, row};

/// Convert an sRGB hex literal (e.g. `0x175CD3`) to Rune's linear sRGB `Color`.
pub fn hex(rgb: u32) -> Color {
    let srgb = |byte: u8| {
        let c = (byte as f32) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    Color {
        r: srgb(((rgb >> 16) & 0xFF) as u8),
        g: srgb(((rgb >> 8) & 0xFF) as u8),
        b: srgb((rgb & 0xFF) as u8),
        a: 1.0,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub canvas: Color,
    pub surface: Color,
    pub surface_subtle: Color,
    pub hairline: Color,
    pub hairline_strong: Color,
    pub ink: Color,
    pub ink_muted: Color,
    pub accent: Color,
    pub accent_soft: Color,
    pub on_accent: Color,
    pub healthy: Color,
    pub healthy_soft: Color,
    pub warn: Color,
    pub warn_soft: Color,
    pub critical: Color,
    pub critical_soft: Color,
}

/// Tailored Precision Instrument palette (Cool Architectural Alabaster default + Obsidian dark mode).
pub fn palette(dark: bool) -> Palette {
    if dark {
        Palette {
            canvas: hex(0x0D1014),
            surface: hex(0x14191F),
            surface_subtle: hex(0x1B222A),
            hairline: hex(0x27303B),
            hairline_strong: hex(0x364251),
            ink: hex(0xEFF3F8),
            ink_muted: hex(0x93A0AE),
            accent: hex(0x4F8CFF),
            accent_soft: hex(0x172642),
            on_accent: hex(0xFFFFFF),
            healthy: hex(0x2BB673),
            healthy_soft: hex(0x122A20),
            warn: hex(0xE89B2D),
            warn_soft: hex(0x2D2212),
            critical: hex(0xF05252),
            critical_soft: hex(0x331618),
        }
    } else {
        Palette {
            canvas: hex(0xF4F5F3),
            surface: hex(0xFFFFFF),
            surface_subtle: hex(0xECEEEB),
            hairline: hex(0xD9DDD8),
            hairline_strong: hex(0xBFC6BF),
            ink: hex(0x121518),
            ink_muted: hex(0x525A62),
            accent: hex(0x175CD3),
            accent_soft: hex(0xEBF2FF),
            on_accent: hex(0xFFFFFF),
            healthy: hex(0x0E7A4B),
            healthy_soft: hex(0xE6F5EE),
            warn: hex(0xB45309),
            warn_soft: hex(0xFEF3E2),
            critical: hex(0xC81E1E),
            critical_soft: hex(0xFDECEC),
        }
    }
}

/// GPU-rendered bar sparkline with optional rollout baseline threshold & highlight band.
pub fn sparkline(
    values: &[f64],
    height: f32,
    baseline_threshold: Option<f64>,
    p: Palette,
) -> El {
    if values.is_empty() {
        return el().w_full().h(height).radius(4.0).fill(p.surface_subtle);
    }

    let max_val = values
        .iter()
        .copied()
        .fold(baseline_threshold.unwrap_or(1.0), f64::max)
        .max(1.0);

    let mut bars = row()
        .w_full()
        .h(height)
        .gap(2.0)
        .px(3.0)
        .pt(4.0)
        .pb(3.0);

    for &v in values {
        let ratio = (v / max_val).clamp(0.10, 1.0) as f32;
        let bar_h = ((height - 7.0) * ratio).max(3.0);
        let breach = baseline_threshold.is_some_and(|t| v > t);
        let fill = if breach { p.critical } else { p.accent };
        bars = bars.child(
            col()
                .grow(1.0)
                .h_full()
                .child(el().grow(1.0))
                .child(el().w_full().h(bar_h).radius(1.5).fill(fill)),
        );
    }

    let mut container = el()
        .w_full()
        .h(height)
        .radius(4.0)
        .fill(p.surface_subtle)
        .child(bars);

    if let Some(threshold) = baseline_threshold {
        let thresh_ratio = (threshold / max_val).clamp(0.05, 0.95) as f32;
        let y = (height - 4.0) * (1.0 - thresh_ratio);
        container = container.child(
            el().w_full()
                .h(1.0)
                .fill(p.warn.alpha(0.65))
                .absolute(0.0, y),
        );
    }

    container
}

/// Kubernetes `usage / request / limit` utilization bar with request marker tick.
pub fn utilization_bar(usage: u32, request: u32, limit: u32, width: f32, p: Palette) -> El {
    let denom = limit.max(usage).max(1) as f32;
    let usage_w = ((usage as f32 / denom).clamp(0.03, 1.0) * width).round();
    let req_x = ((request as f32 / denom).clamp(0.0, 0.98) * width).round();
    let ratio = usage as f32 / denom;
    let bar_fill = if ratio >= 0.85 {
        p.critical
    } else if ratio >= 0.65 {
        p.warn
    } else {
        p.accent
    };

    col().w(width).h(8.0).child(
        el().w(width)
            .h(8.0)
            .radius(2.0)
            .fill(p.surface_subtle)
            .child(el().w(usage_w).h(8.0).radius(2.0).fill(bar_fill).absolute(0.0, 0.0))
            .child(el().w(1.5).h(8.0).fill(p.ink.alpha(0.55)).absolute(req_x, 0.0)),
    )
}
