import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/status-badge";

describe("StatusBadge", () => {
  it('renders "UP" text for UP status with success token', () => {
    const { container } = render(<StatusBadge status="UP" />);
    expect(screen.getByText("UP")).toBeInTheDocument();
    expect(container.querySelector("[class*=success]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it('renders "DOWN" text for DOWN status with destructive token', () => {
    const { container } = render(<StatusBadge status="DOWN" />);
    expect(screen.getByText("DOWN")).toBeInTheDocument();
    expect(container.querySelector("[class*=destructive]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it('renders "GRACE" text for GRACE status with warning token', () => {
    const { container } = render(<StatusBadge status="GRACE" />);
    expect(screen.getByText("GRACE")).toBeInTheDocument();
    expect(container.querySelector("[class*=warning]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it('renders "NEW" text for NEW status with primary token', () => {
    const { container } = render(<StatusBadge status="NEW" />);
    expect(screen.getByText("NEW")).toBeInTheDocument();
    expect(container.querySelector("[class*=primary]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it('renders "PAUSED" text for PAUSED status with muted token', () => {
    const { container } = render(<StatusBadge status="PAUSED" />);
    expect(screen.getByText("PAUSED")).toBeInTheDocument();
    expect(container.querySelector("[class*=muted]")).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
