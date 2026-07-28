import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LandingPage from "@/app/(marketing)/page";
import { APP_NAV } from "@/components/app/sidebar";
import { SITE } from "@/lib/site";

describe("per-check notification routing product surface", () => {
  it("removes escalation from application navigation", () => {
    expect(APP_NAV.map(({ label }) => label)).not.toContain("Escalation");
    expect(APP_NAV.map(({ href }) => href)).not.toContain("/escalation");
  });

  it("shows selected Email, Telegram, and Webhook routes for DOWN and recovery", () => {
    const { container } = render(<LandingPage />);

    const routing = screen.getByRole("region", {
      name: /per-check notification routing/i,
    });
    expect(
      within(routing).getByRole("heading", {
        name: /route each check to the right channels/i,
      }),
    ).toBeInTheDocument();
    expect(within(routing).getByText("Database API")).toBeInTheDocument();
    const eventBadge = within(routing).getByText("DOWN + RECOVERY");
    expect(eventBadge).toHaveClass("text-foreground");
    expect(eventBadge).not.toHaveClass("text-primary");
    expect(
      within(routing).getByText(/recovery is sent only when a down check returns up/i),
    ).toBeInTheDocument();
    expect(screen.getByText("We notify on recovery")).toBeInTheDocument();

    for (const [name, icon] of [
      ["Email", "mail"],
      ["Telegram", "send"],
      ["Webhook", "webhook"],
    ] as const) {
      const row = within(routing).getByRole("listitem", { name });
      expect(within(row).getByText(name)).toBeInTheDocument();
      expect(row.querySelector(`.lucide-${icon}`)).toBeInTheDocument();
    }

    const publicCopy = [
      container.textContent,
      SITE.description,
      SITE.capabilities.platform.join(" "),
    ].join(" ");
    expect(publicCopy).not.toMatch(/escalat|acknowledg/i);
  });
});
