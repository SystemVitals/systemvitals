import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ResponseTimeChart } from "@/components/response-time-chart";

// Points arrive from the API newest-first, exactly as `events` does.
const NEWEST_FIRST = [
  { timestamp: "2026-07-22T14:35:50.897Z", responseTimeMs: 110 },
  { timestamp: "2026-07-22T14:30:35.905Z", responseTimeMs: 128 },
  { timestamp: "2026-07-22T13:22:20.900Z", responseTimeMs: 315 },
  { timestamp: "2026-07-22T12:56:05.600Z", responseTimeMs: 86 },
];

function tableRows() {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1) // drop the header row
    .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
}

describe("ResponseTimeChart", () => {
  it("plots oldest-to-newest, whatever order the API returned", () => {
    render(<ResponseTimeChart points={NEWEST_FIRST} />);

    // Guards the reversal: the API hands back newest-first, and plotting in
    // that order runs time backwards across the x-axis.
    expect(tableRows().map((cells) => cells[1])).toEqual([
      "86 ms",
      "315 ms",
      "128 ms",
      "110 ms",
    ]);
  });

  it("keeps every point reachable as text, so the tooltip never gates the data", () => {
    render(<ResponseTimeChart points={NEWEST_FIRST} />);

    expect(tableRows()).toHaveLength(NEWEST_FIRST.length);
  });

  it("reports a missing measurement rather than dropping the point", () => {
    const withOutage = [
      { timestamp: "2026-07-22T14:35:50.000Z", responseTimeMs: 110 },
      { timestamp: "2026-07-22T14:30:35.000Z", responseTimeMs: null },
      { timestamp: "2026-07-22T14:25:20.000Z", responseTimeMs: 128 },
    ];
    render(<ResponseTimeChart points={withOutage} />);

    // Filtering nulls out would draw the line straight across the outage and
    // lose the row entirely.
    const rows = tableRows();
    expect(rows).toHaveLength(3);
    expect(rows[1][1]).toBe("No response");
  });

  it("renders an empty state when there is nothing to plot", () => {
    render(<ResponseTimeChart points={[]} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("treats an all-null series as having nothing to plot", () => {
    render(
      <ResponseTimeChart
        points={[{ timestamp: "2026-07-22T14:35:50.000Z", responseTimeMs: null }]}
      />
    );
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("carries no legend, since a single series is named by its heading", () => {
    const { container } = render(<ResponseTimeChart points={NEWEST_FIRST} />);
    expect(container.querySelector(".recharts-legend-wrapper")).toBeNull();
  });
});
