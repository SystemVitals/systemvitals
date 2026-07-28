import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Hero } from "./hero";

describe("Hero", () => {
  it("renders the tagline headline and a Start free CTA to /signup", () => {
    render(<Hero />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/flatline/i);
    const cta = screen.getByRole("link", { name: /start free/i });
    expect(cta.getAttribute("href")).toBe("/signup");
  });
});
