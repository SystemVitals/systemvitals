import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata as privacyMetadata } from "./privacy/page";
import TermsPage, { metadata as termsMetadata } from "./terms/page";
import { MarketingFooter } from "@/components/marketing/footer";

describe("legal pages", () => {
  it("renders the Terms and Conditions with its effective date and section index", () => {
    render(<TermsPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Terms and Conditions" })
    ).toBeTruthy();
    expect(screen.getByText("Effective July 25, 2026")).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Terms and Conditions sections" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Acceptable use" })).toBeTruthy();
    expect(termsMetadata.alternates).toEqual({ canonical: "/terms" });
  });

  it("renders the Privacy Policy with data rights and contact details", () => {
    render(<PrivacyPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Privacy Policy" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your privacy rights" })).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "support@systemvitals.link" }).length
    ).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(
      /Telegram destination identifiers, titles, and topic identifiers/i
    );
    expect(document.body.textContent).toMatch(
      /alert content.*Telegram.*delivery/i
    );
    expect(privacyMetadata.alternates).toEqual({ canonical: "/privacy" });
  });

  it("links both policies from the public footer", () => {
    render(<MarketingFooter />);

    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy"
    );
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "/terms"
    );
  });
});
