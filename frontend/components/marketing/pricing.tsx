"use client";
import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { SITE } from "@/lib/site";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SHARED_FEATURES = [
  "All monitor types",
  "All alert channels",
  "Escalation policies",
  "Status pages",
  "API + MCP",
];

type Interval = "month" | "year";

export function Pricing() {
  const [interval, setInterval] = useState<Interval>("month");
  const yearly = interval === "year";

  return (
    <section id="pricing" className="py-20 px-4">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-3">
            Simple, transparent pricing
          </h2>
          <p className="text-muted-foreground text-lg">
            Monitor your systems — pick the plan that fits.
          </p>
        </div>

        {/* Billing interval toggle */}
        <div className="flex items-center justify-center gap-3 mb-10">
          <div className="inline-flex items-center rounded-full border p-1 text-sm">
            <button
              type="button"
              onClick={() => setInterval("month")}
              className={cn(
                "rounded-full px-4 py-1.5 font-medium transition-colors",
                !yearly
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setInterval("year")}
              className={cn(
                "rounded-full px-4 py-1.5 font-medium transition-colors flex items-center gap-2",
                yearly
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Yearly
              <Badge variant="secondary" className="text-[10px]">
                {SITE.yearlyDiscountLabel}
              </Badge>
            </button>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-3">
          {SITE.pricing.map((tier) => {
            const isFree = tier.plan === "SOLO";
            const displayPrice = yearly ? tier.yearlyPerMonth : tier.priceMonthly;
            return (
              <Card
                key={tier.tier}
                className={cn(
                  "flex flex-col",
                  tier.highlighted && "ring-2 ring-primary"
                )}
              >
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-lg">{tier.tier}</CardTitle>
                    {tier.highlighted && (
                      <Badge variant="default">Most popular</Badge>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1 mt-2">
                    <span className="text-3xl font-bold">{displayPrice}</span>
                    <span className="text-muted-foreground text-sm">/mo</span>
                  </div>
                  <p className="text-xs text-muted-foreground h-4">
                    {yearly && !isFree
                      ? `${tier.priceYearly} billed yearly`
                      : ""}
                  </p>
                  <CardDescription>{tier.blurb}</CardDescription>
                </CardHeader>

                <CardContent className="flex-1">
                  <ul className="space-y-2 text-sm">
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-primary shrink-0" />
                      <span>{tier.maxChecks} checks</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-primary shrink-0" />
                      <span>{tier.minInterval} interval</span>
                    </li>
                    {SHARED_FEATURES.map((feature) => (
                      <li key={feature} className="flex items-center gap-2">
                        <Check className="size-4 text-primary shrink-0" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>

                <CardFooter className="border-t-0 bg-transparent pt-4">
                  <Link
                    href={tier.href}
                    className={cn(
                      buttonVariants({
                        variant: tier.highlighted ? "default" : "outline",
                        size: "default",
                      }),
                      "w-full justify-center"
                    )}
                  >
                    {tier.cta}
                  </Link>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}
