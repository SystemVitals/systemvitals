import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { buttonVariants } from "@/components/ui/button";
import { SITE } from "@/lib/site";

const FOOTER_COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Features", href: "/#features" },
      { label: "Pricing", href: "/#pricing" },
      { label: "Status pages", href: "/#status-pages" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Docs", href: "https://github.com/SystemVitals/systemvitals" },
      { label: "MCP", href: "/#mcp" },
      { label: "API", href: "https://github.com/SystemVitals/systemvitals" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-border/60 bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand column */}
          <div className="flex flex-col gap-4">
            <Wordmark />
            <p className="text-sm text-muted-foreground max-w-[200px]">
              {SITE.tagline}
            </p>
          </div>
          {/* Link columns */}
          {FOOTER_COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">{col.heading}</h3>
              <ul className="flex flex-col gap-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {/* CTA row */}
        <div className="mt-12 flex flex-col items-center gap-4 border-t border-border/60 pt-8 text-center">
          <p className="text-base font-medium">Start monitoring free — no credit card required.</p>
          <Link href="/signup" className={buttonVariants({ size: "lg" })}>
            Start monitoring free
          </Link>
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} {SITE.name}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
