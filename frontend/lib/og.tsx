import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * Shared renderer for every Open Graph / Twitter card in the app.
 *
 * Satori (the engine behind `next/og`) only implements a subset of CSS — no
 * `display: block`, no `filter`, and every multi-child element must be a flex
 * container. Keep that in mind before adding anything here.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

/** Brand tokens from app/globals.css, resolved out of oklch — satori can't parse oklch(). */
const C = {
  bg: "#0B1219",
  fg: "#F2F5F8",
  muted: "#95A0AB",
  teal: "#48B7BD",
  tealDeep: "#14808C",
  coral: "#F9586C",
  success: "#43B966",
  warning: "#E9A13B",
} as const;

export type OgTone = "brand" | "up" | "degraded" | "down";

const TONE_COLOR: Record<OgTone, string> = {
  brand: C.success,
  up: C.success,
  degraded: C.warning,
  down: C.coral,
};

// ── EKG trace ────────────────────────────────────────────────────────────────
// Four beats of the brand waveform, drawn edge to edge under the copy.

const TRACE_W = 1056;
const TRACE_H = 96;
const BASE_Y = 52;

function beat(x: number): string {
  return [
    `L${x + 54},${BASE_Y}`,
    `L${x + 66},${BASE_Y + 7}`, // Q
    `L${x + 78},${BASE_Y - 8}`,
    `L${x + 90},${BASE_Y - 44}`, // R peak
    `L${x + 104},${BASE_Y + 40}`, // S trough
    `L${x + 116},${BASE_Y - 6}`,
    `L${x + 128},${BASE_Y}`,
    `L${x + 168},${BASE_Y}`,
    `L${x + 186},${BASE_Y - 14}`, // T
    `L${x + 204},${BASE_Y}`,
  ].join("");
}

const TRACE_D =
  `M0,${BASE_Y}` + [0, 264, 528, 792].map(beat).join("") + `L1030,${BASE_Y}`;

/** Favicon-weight EKG mark, reused inside the card's logo tile. */
const MARK_D = "M3.5 16H11.4L14.1 6.2L17.7 25.8L20.5 16H28.5";

// ── Fonts ────────────────────────────────────────────────────────────────────
// Space Grotesk is vendored under assets/fonts/ so builds never depend on
// reaching Google Fonts. next.config.ts traces the directory into the
// standalone output for each route that renders a card.

let fonts: Promise<[Buffer, Buffer]> | null = null;

function loadFonts(): Promise<[Buffer, Buffer]> {
  fonts ??= Promise.all([
    readFile(join(process.cwd(), "assets/fonts/SpaceGrotesk-Bold.ttf")),
    readFile(join(process.cwd(), "assets/fonts/SpaceGrotesk-Medium.ttf")),
  ]);
  return fonts;
}

// ── Card ─────────────────────────────────────────────────────────────────────

export interface OgCardOptions {
  /** Headline. Wraps naturally. */
  title: string;
  /** Optional trailing fragment rendered in coral on its own line. */
  titleAccent?: string;
  subtitle: string;
  pill: { label: string; tone: OgTone };
}

export async function renderOgCard({
  title,
  titleAccent,
  subtitle,
  pill,
}: OgCardOptions): Promise<ImageResponse> {
  const [bold, medium] = await loadFonts();
  const dot = TONE_COLOR[pill.tone];

  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: C.bg,
          fontFamily: "Space Grotesk",
        }}
      >
        {/* Monitor grid */}
        {Array.from({ length: 23 }, (_, i) => (
          <div
            key={`v${i}`}
            style={{
              position: "absolute",
              left: (i + 1) * 50,
              top: 0,
              width: 1,
              height: OG_SIZE.height,
              backgroundColor: "rgba(255,255,255,0.03)",
            }}
          />
        ))}
        {Array.from({ length: 12 }, (_, i) => (
          <div
            key={`h${i}`}
            style={{
              position: "absolute",
              left: 0,
              top: (i + 1) * 50,
              width: OG_SIZE.width,
              height: 1,
              backgroundColor: "rgba(255,255,255,0.03)",
            }}
          />
        ))}

        {/* Atmosphere */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%",
            height: "100%",
            backgroundImage:
              "radial-gradient(circle at 6% -18%, rgba(20,128,140,0.55) 0%, rgba(11,18,25,0) 58%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%",
            height: "100%",
            backgroundImage:
              "radial-gradient(circle at 104% 120%, rgba(249,88,108,0.28) 0%, rgba(11,18,25,0) 55%)",
          }}
        />

        {/* Top rule */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%",
            height: 6,
            backgroundImage: `linear-gradient(90deg, ${C.tealDeep}, ${C.teal} 45%, ${C.coral})`,
          }}
        />

        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            padding: "58px 72px 52px 72px",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
            }}
          >
            <div style={{ display: "flex", alignItems: "center" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 58,
                  height: 58,
                  borderRadius: 15,
                  backgroundImage: `linear-gradient(135deg, #17909E, #0B6270)`,
                }}
              >
                <svg width="36" height="36" viewBox="0 0 32 32">
                  <path
                    d={MARK_D}
                    fill="none"
                    stroke="#FFFFFF"
                    strokeWidth={3.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div
                style={{
                  marginLeft: 20,
                  fontSize: 34,
                  fontWeight: 700,
                  color: C.fg,
                  letterSpacing: -0.6,
                }}
              >
                SystemVitals
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "13px 24px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.14)",
                backgroundColor: "rgba(255,255,255,0.05)",
              }}
            >
              <div
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 999,
                  backgroundColor: dot,
                  boxShadow: `0 0 0 5px ${dot}26`,
                }}
              />
              <div
                style={{
                  marginLeft: 15,
                  fontSize: 17,
                  fontWeight: 500,
                  color: C.fg,
                  letterSpacing: 1.6,
                }}
              >
                {pill.label.toUpperCase()}
              </div>
            </div>
          </div>

          {/* Headline */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              justifyContent: "center",
              paddingTop: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                fontSize: 60,
                fontWeight: 700,
                lineHeight: 1.1,
                letterSpacing: -1.8,
                color: C.fg,
                maxWidth: 940,
              }}
            >
              <div style={{ display: "flex" }}>{title}</div>
              {titleAccent ? (
                <div style={{ display: "flex", color: C.coral }}>{titleAccent}</div>
              ) : null}
            </div>

            <div
              style={{
                display: "flex",
                marginTop: 26,
                fontSize: 23,
                fontWeight: 500,
                lineHeight: 1.45,
                color: C.muted,
                maxWidth: 860,
              }}
            >
              {subtitle}
            </div>
          </div>

          {/* Waveform readout */}
          <div style={{ display: "flex", marginTop: 10 }}>
            <svg width={TRACE_W} height={TRACE_H} viewBox={`0 0 ${TRACE_W} ${TRACE_H}`}>
              <path
                d={TRACE_D}
                fill="none"
                stroke={C.teal}
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx={1034} cy={BASE_Y} r={17} fill={C.coral} fillOpacity={0.2} />
              <circle cx={1034} cy={BASE_Y} r={8} fill={C.coral} />
            </svg>
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Space Grotesk", data: bold, weight: 700, style: "normal" },
        { name: "Space Grotesk", data: medium, weight: 500, style: "normal" },
      ],
    }
  );
}
