export const SITE = {
  name: "SystemVitals",
  tagline: "Know the moment your systems flatline.",
  description:
    "Uptime & cron-job monitoring: passive heartbeat dead-man's-switch, active HTTP/TCP/ping probing, per-check notification routing, and public status pages.",
  // Absolute origin, used as Next's `metadataBase` so og:image / og:url resolve
  // to absolute URLs — social crawlers reject relative ones. Baked in at build
  // time (see frontend/Dockerfile), so it must be passed as a build arg.
  url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:9999",
  nav: [
    { label: "Features", href: "/#features" },
    { label: "How it works", href: "/#how-it-works" },
    { label: "Pricing", href: "/#pricing" },
    { label: "Docs", href: "https://github.com/SystemVitals/systemvitals" },
  ],
  capabilities: {
    monitors: ["HTTP", "TCP", "Ping", "Heartbeat"],
    channels: ["Email", "Slack", "Telegram", "Webhook"],
    platform: ["Per-check routing", "Status pages", "MCP"],
  },
  // Display prices. The amounts Stripe actually charges live in the API at
  // api/src/billing/plan-pricing.ts — keep these in sync. Yearly = 50% off
  // 12× monthly, shown as an effective per-month price.
  yearlyDiscountLabel: "Save 50%",
  pricing: [
    { tier: "Solo", plan: "SOLO",
      priceMonthly: "$0", priceYearly: "$0", yearlyPerMonth: "$0",
      maxChecks: 5, minInterval: "5 min",
      cta: "Start free", href: "/signup", highlighted: false,
      blurb: "For a personal project or a couple of cron jobs." },
    { tier: "Signal", plan: "SIGNAL",
      priceMonthly: "$5", priceYearly: "$30", yearlyPerMonth: "$2.50",
      maxChecks: 100, minInterval: "1 min",
      cta: "Start Signal", href: "/signup", highlighted: true,
      blurb: "For real production workloads." },
    { tier: "Fleet", plan: "FLEET",
      priceMonthly: "$20", priceYearly: "$120", yearlyPerMonth: "$10",
      maxChecks: 1000, minInterval: "1 min",
      cta: "Start Fleet", href: "/signup", highlighted: false,
      blurb: "For monitoring many systems at scale." },
  ],
} as const;
