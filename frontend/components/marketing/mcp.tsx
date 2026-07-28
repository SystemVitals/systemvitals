import { TerminalSquare } from "lucide-react";

const INTERACTION_LINES = [
  { type: "input" as const, text: "> create a heartbeat check for nightly-backup, 1h period, 10m grace" },
  { type: "output" as const, text: "✓ check created — ping: https://systemvitals.app/ping/8f3c…" },
  { type: "input" as const, text: "> route its alerts to Email, Telegram, and my incident webhook" },
  { type: "output" as const, text: "✓ routing saved · DOWN + recovery (DOWN → UP)" },
];

export function Mcp() {
  return (
    <section
      id="mcp"
      className="border-t border-border px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <div className="rounded-2xl border border-border bg-card px-6 py-12 sm:px-12">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
            {/* Left: copy */}
            <div>
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <TerminalSquare className="h-5 w-5 text-primary" />
              </div>
              <p className="mb-2 text-sm font-medium uppercase tracking-widest text-primary">
                Built for developers
              </p>
              <h2 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">
                Run it from Claude Code
              </h2>
              <p className="mt-4 text-muted-foreground">
                SystemVitals ships a built-in MCP server that exposes the full
                management surface to Claude Code. Create checks, wire up
                notification routes, and manage alert channels — all from a
                natural-language conversation, with no context switching.
              </p>
              <p className="mt-3 text-muted-foreground">
                The same GraphQL API powering the web UI is available over any
                ApiToken, so scripts, CI pipelines, and AI agents all use the
                identical surface.
              </p>
            </div>

            {/* Right: code block */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Example interaction
              </p>
              <div className="rounded-xl border border-border bg-muted p-6 font-mono text-sm">
                {INTERACTION_LINES.map((line, idx) => (
                  <p
                    key={idx}
                    className={
                      line.type === "input"
                        ? "text-muted-foreground"
                        : "text-primary"
                    }
                  >
                    {line.text}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
