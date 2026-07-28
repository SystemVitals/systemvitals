import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Pricing } from "./pricing";

describe("Pricing", () => {
  it("renders the three real tiers with their check limits", () => {
    render(<Pricing />);
    expect(screen.getByText("Solo")).toBeTruthy();
    expect(screen.getByText("Signal")).toBeTruthy();
    expect(screen.getByText("Fleet")).toBeTruthy();
    expect(screen.getByText(/5 checks/i)).toBeTruthy();
    expect(screen.getByText(/1000 checks/i)).toBeTruthy();
  });

  it("shows a one-minute interval for both paid tiers with no one-second claim", () => {
    render(<Pricing />);

    expect(screen.getAllByText("1 min interval")).toHaveLength(2);
    expect(screen.queryByText("1 sec interval")).toBeNull();
  });
});
