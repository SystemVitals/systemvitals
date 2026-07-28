import Link from "next/link";
import { Heartbeat } from "@/components/heartbeat";

export type LegalSection = {
  id: string;
  title: string;
  content: React.ReactNode;
};

type LegalDocumentProps = {
  eyebrow: string;
  title: string;
  summary: string;
  effectiveDate: string;
  sections: LegalSection[];
};

export function LegalDocument({
  eyebrow,
  title,
  summary,
  effectiveDate,
  sections,
}: LegalDocumentProps) {
  return (
    <div className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96 bg-[radial-gradient(circle_at_20%_10%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_48%),radial-gradient(circle_at_80%_20%,color-mix(in_oklab,var(--accent)_8%,transparent),transparent_42%)]"
      />

      <header className="mx-auto max-w-6xl px-4 pb-12 pt-16 sm:pb-16 sm:pt-24">
        <div className="max-w-3xl">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            {eyebrow}
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
            {title}
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            {summary}
          </p>
          <div className="mt-8 flex items-center gap-3 text-sm text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
            Effective {effectiveDate}
          </div>
        </div>
        <Heartbeat variant="divider" className="mt-12 max-w-3xl text-primary/45" />
      </header>

      <div className="mx-auto grid max-w-6xl gap-12 px-4 pb-24 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-20">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <p className="mb-4 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            On this page
          </p>
          <nav aria-label={`${title} sections`}>
            <ol className="space-y-1 border-l border-border">
              {sections.map((section, index) => (
                <li key={section.id}>
                  <Link
                    href={`#${section.id}`}
                    className="group flex gap-3 border-l border-transparent py-2 pl-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                  >
                    <span className="font-mono text-xs text-muted-foreground/70">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>{section.title}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </nav>
        </aside>

        <article className="min-w-0">
          {sections.map((section, index) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-28 border-t border-border py-10 first:border-t-0 first:pt-0"
            >
              <div className="mb-5 flex items-baseline gap-4">
                <span className="font-mono text-xs text-primary">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h2 className="text-2xl font-semibold tracking-tight">
                  {section.title}
                </h2>
              </div>
              <div className="space-y-4 text-[0.95rem] leading-7 text-muted-foreground [&_a]:font-medium [&_a]:text-primary [&_a]:underline-offset-4 [&_a:hover]:underline [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:ml-5 [&_ul]:list-disc [&_ul]:space-y-2">
                {section.content}
              </div>
            </section>
          ))}

          <div className="mt-8 rounded-xl border border-primary/20 bg-primary/5 p-6">
            <p className="font-heading text-lg font-semibold text-foreground">
              Questions about these terms?
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Contact us at{" "}
              <a
                href="mailto:support@systemvitals.link"
                className="font-medium text-primary hover:underline"
              >
                support@systemvitals.link
              </a>
              .
            </p>
          </div>
        </article>
      </div>
    </div>
  );
}
