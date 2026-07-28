import { Fragment } from "react";
import { Heartbeat } from "@/components/heartbeat";

const STEPS = [
  {
    number: "01",
    title: "Create a check",
    body: "Add an HTTP/TCP/ping check, or grab a heartbeat ping URL for your job.",
  },
  {
    number: "02",
    title: "We watch the pulse",
    body: "Passive heartbeats and active probes, evaluated against your interval + grace.",
  },
  {
    number: "03",
    title: "We notify on recovery",
    body: "The moment something flatlines, selected channels receive DOWN. When it returns UP, they receive recovery.",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-border px-4 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-primary">
            Simple by design
          </p>
          <h2 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">
            How it works
          </h2>
        </div>

        <div className="flex flex-col items-center gap-0">
          {STEPS.map((step, idx) => (
            <Fragment key={step.number}>
              <div className="flex w-full max-w-2xl flex-col items-center gap-3 text-center sm:flex-row sm:items-start sm:text-left">
                <span className="font-heading text-5xl font-bold text-primary/20 sm:w-20 sm:shrink-0 sm:text-right">
                  {step.number}
                </span>
                <div className="sm:pt-2">
                  <p className="text-lg font-semibold">{step.title}</p>
                  <p className="mt-1 text-muted-foreground">{step.body}</p>
                </div>
              </div>
              {idx < STEPS.length - 1 && (
                <Heartbeat
                  variant="divider"
                  className="my-4 w-full max-w-2xl text-primary"
                />
              )}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
