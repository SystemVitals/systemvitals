import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/status-badge";

describe("StatusBadge", () => {
  it('renders "Up" text for UP status with success token', () => {
    const { container } = render(<StatusBadge status="UP" />);
    expect(screen.getByText("Up")).toBeInTheDocument();
    expect(container.querySelector("[class*=success]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it('renders "Down" text for DOWN status with destructive token', () => {
    const { container } = render(<StatusBadge status="DOWN" />);
    expect(screen.getByText("Down")).toBeInTheDocument();
    expect(container.querySelector("[class*=destructive]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it('renders "Late" text for GRACE status with warning token', () => {
    const { container } = render(<StatusBadge status="GRACE" />);
    expect(screen.getByText("Late")).toBeInTheDocument();
    expect(container.querySelector("[class*=warning]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it('renders "Waiting" text for NEW status with primary token', () => {
    const { container } = render(<StatusBadge status="NEW" />);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    expect(container.querySelector("[class*=primary]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it('renders "Paused" text for PAUSED status with muted token', () => {
    const { container } = render(<StatusBadge status="PAUSED" />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(container.querySelector("[class*=muted]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("names the badge with the plain-language label and explains the state", () => {
    render(<StatusBadge status="GRACE" />);
    const badge = screen.getByRole("status", { name: "Late" });
    expect(badge).toHaveAttribute("title", "Overdue, inside the grace period");
  });
});
