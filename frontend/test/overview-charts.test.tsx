import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BrokenTimeChart } from "@/components/overview/broken-time-chart";
import { OrganizationBrokenTime } from "@/components/overview/organization-broken-time";
import { OutageTimeline } from "@/components/overview/outage-timeline";
import { LongestBrokenTable } from "@/components/overview/longest-broken-table";
import { formatDateTime } from "@/lib/format";
import { formatUptime, type CheckBrokenTimeRow } from "@/lib/overview";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_START = "2026-10-28T00:00:00.000Z";
const RANGE_END = "2026-11-04T00:00:00.000Z";
const START_MS = Date.parse(RANGE_START);
const END_MS = Date.parse(RANGE_END);

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function percent(value: string) {
  expect(value).toMatch(/%$/);
  return parseFloat(value);
}

type SpanInput = {
  startedAt: string;
  endedAt: string | null;
  outageCount?: number;
  brokenSeconds?: number;
};

/** One timeline row; spans default to a single outage covering the span. */
function timelineRow(id: string, outages: SpanInput[], name = id) {
  return {
    check: { id, name },
    organization: { name: "Acme Prod" },
    outages: outages.map((span) => ({
      outageCount: 1,
      brokenSeconds:
        (Date.parse(span.endedAt ?? RANGE_END) - Math.max(START_MS, Date.parse(span.startedAt))) /
        1000,
      ...span,
    })),
  };
}

function segments() {
  return screen.getAllByRole("button", { name: /^Down/ });
}

function brokenRow(overrides: Partial<CheckBrokenTimeRow> = {}): CheckBrokenTimeRow {
  return {
    check: { id: "c1", name: "nightly-backup", slug: "nightly-backup" },
    organization: { id: "o1", name: "Side Projects", slug: "side" },
    brokenSeconds: 111900,
    outageCount: 2,
    longestOutageSeconds: 108000,
    longestOutageOngoing: false,
    ongoing: false,
    uptimePercent: 95.6789,
    outages: [],
    ...overrides,
  };
}

describe("BrokenTimeChart", () => {
  const buckets = [
    { start: "2026-11-02T00:00:00.000Z", brokenSeconds: 0 },
    { start: "2026-11-03T00:00:00.000Z", brokenSeconds: 3600 },
  ];

  it("labels the daily chart, drawn inside ChartContainer", () => {
    render(<BrokenTimeChart buckets={buckets} hourly={false} />);
    const chart = screen.getByRole("figure", { name: "Time broken per day" });
    expect(chart).toHaveAttribute("data-slot", "chart");
  });

  it("labels the hourly chart", () => {
    render(<BrokenTimeChart buckets={buckets} hourly />);
    expect(screen.getByRole("figure", { name: "Time broken per hour" })).toBeInTheDocument();
  });
});

describe("OrganizationBrokenTime", () => {
  const rows = [
    { organization: { id: "o1", name: "Side Projects" }, brokenSeconds: 111900 },
    { organization: { id: "o2", name: "Acme Prod" }, brokenSeconds: 34620 },
    { organization: { id: "o3", name: "Nimbus" }, brokenSeconds: 0 },
  ];

  function barOf(name: string) {
    const row = screen.getByText(name).closest("li");
    return row!.querySelector<HTMLElement>('[data-slot="bar"]')!;
  }

  it("labels each organization with its broken time", () => {
    render(<OrganizationBrokenTime rows={rows} />);
    expect(screen.getByText("1d 7h")).toBeInTheDocument();
    expect(screen.getByText("9h 37m")).toBeInTheDocument();
    expect(screen.getByText("0m")).toBeInTheDocument();
  });

  it("sizes bars against the widest organization", () => {
    render(<OrganizationBrokenTime rows={rows} />);
    expect(barOf("Side Projects").style.width).toBe("100%");
    expect(percent(barOf("Acme Prod").style.width)).toBeCloseTo(30.94, 1);
    expect(barOf("Nimbus").style.width).toBe("0%");
  });
});

describe("OutageTimeline", () => {
  it("places a segment by its share of the range", () => {
    render(
      <OutageTimeline
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        rows={[timelineRow("c1", [{ startedAt: iso(END_MS - DAY_MS), endedAt: RANGE_END }])]}
        late={[]}
      />,
    );
    const [segment] = segments();
    expect(percent(segment.style.left)).toBeCloseTo(85.71, 2);
    expect(percent(segment.style.width)).toBeCloseTo(14.29, 2);
  });

  it("keeps a short outage visible with a minimum width", () => {
    const start = END_MS - 3 * DAY_MS;
    render(
      <OutageTimeline
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        rows={[
          timelineRow("c1", [{ startedAt: iso(start), endedAt: iso(start + 15 * 60_000) }]),
        ]}
        late={[]}
      />,
    );
    const [segment] = segments();
    expect(percent(segment.style.width)).toBeLessThan(0.2);
    expect(segment).toHaveClass("min-w-1");
  });

  it("runs an ongoing outage to the right edge", () => {
    render(
      <OutageTimeline
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        rows={[timelineRow("c1", [{ startedAt: iso(END_MS - 2 * DAY_MS), endedAt: null }])]}
        late={[]}
      />,
    );
    const [segment] = segments();
    expect(percent(segment.style.left) + percent(segment.style.width)).toBeCloseTo(100, 2);
    expect(segment).toHaveAccessibleName(/ongoing/);
  });

  it("describes a merged span by its outage count and summed broken time", () => {
    const start = END_MS - 2 * DAY_MS;
    const end = start + 3 * 3_600_000;
    render(
      <OutageTimeline
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        rows={[
          timelineRow("c1", [
            { startedAt: iso(start), endedAt: iso(end), outageCount: 3, brokenSeconds: 4800 },
          ]),
        ]}
        late={[]}
      />,
    );
    expect(screen.getByRole("button", { name: /^3 outages/ })).toHaveAccessibleName(
      `3 outages · 1h 20m down, from ${formatDateTime(iso(start))} to ${formatDateTime(iso(end))}`,
    );
  });

  it("describes an ongoing merged span", () => {
    const start = END_MS - 2 * 3_600_000;
    render(
      <OutageTimeline
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        rows={[
          timelineRow("c1", [
            { startedAt: iso(start), endedAt: null, outageCount: 4, brokenSeconds: 5400 },
          ]),
        ]}
        late={[]}
      />,
    );
    expect(screen.getByRole("button", { name: /^4 outages/ })).toHaveAccessibleName(
      `4 outages · 1h 30m down, from ${formatDateTime(iso(start))}, ongoing`,
    );
  });

  it("labels a single outage from its clipped start so start and duration agree", () => {
    render(
      <OutageTimeline
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        rows={[
          timelineRow("c1", [
            { startedAt: iso(START_MS - DAY_MS), endedAt: iso(START_MS + 3_600_000) },
          ]),
        ]}
        late={[]}
      />,
    );
    const [segment] = segments();
    expect(segment).toHaveAccessibleName(
      `Down from ${formatDateTime(RANGE_START)} to ${formatDateTime(iso(START_MS + 3_600_000))}, 1h`,
    );
  });

  it("caps the rows and says how many more there are", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      timelineRow(`c${index}`, [{ startedAt: iso(END_MS - DAY_MS), endedAt: RANGE_END }], `check-${index}`),
    );
    render(<OutageTimeline rangeStart={RANGE_START} rangeEnd={RANGE_END} rows={rows} late={[]} />);
    const list = screen.getByRole("list", { name: "Checks with outages" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByText("check-10")).toBeNull();
    expect(screen.getByText("and 2 more")).toBeInTheDocument();
  });

  it("marks a currently late heartbeat at now", () => {
    render(
      <OutageTimeline
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        rows={[
          timelineRow("c1", [{ startedAt: iso(END_MS - DAY_MS), endedAt: iso(END_MS - DAY_MS / 2) }], "etl-sync"),
          timelineRow("c2", [{ startedAt: iso(END_MS - DAY_MS), endedAt: RANGE_END }], "api-health"),
        ]}
        late={[{ checkId: "c1" }]}
      />,
    );
    const late = screen.getByText("etl-sync").closest("li")!;
    expect(within(late).getByRole("button", { name: /^Late/ })).toBeInTheDocument();
    const onTime = screen.getByText("api-health").closest("li")!;
    expect(within(onTime).queryByRole("button", { name: /^Late/ })).toBeNull();
  });

  it("shows a Down and Late legend", () => {
    render(
      <OutageTimeline
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        rows={[timelineRow("c1", [{ startedAt: iso(END_MS - DAY_MS), endedAt: RANGE_END }])]}
        late={[]}
      />,
    );
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getByText("Down")).toBeInTheDocument();
    expect(within(legend).getByText("Late")).toBeInTheDocument();
  });
});

describe("LongestBrokenTable", () => {
  it("tags the longest outage ONGOING only when that outage is still open", () => {
    render(
      <LongestBrokenTable
        rows={[
          brokenRow({ ongoing: true, longestOutageOngoing: true }),
          // A shorter outage is open, but the longest one closed.
          brokenRow({
            check: { id: "c2", name: "api-health", slug: "api-health" },
            ongoing: true,
            longestOutageOngoing: false,
          }),
        ]}
      />,
    );
    expect(screen.getAllByText("ONGOING")).toHaveLength(1);
    const ongoingRow = screen.getByRole("row", { name: /nightly-backup/ });
    expect(within(ongoingRow).getByText("ONGOING")).toBeInTheDocument();
  });

  it("formats uptime like the summary", () => {
    render(
      <LongestBrokenTable
        rows={[
          brokenRow(),
          brokenRow({
            check: { id: "c2", name: "new-check", slug: "new-check" },
            uptimePercent: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText(formatUptime(95.6789))).toBeInTheDocument();
    expect(screen.getByText(formatUptime(null))).toBeInTheDocument();
  });

  it("links each check to its page", () => {
    render(<LongestBrokenTable rows={[brokenRow()]} />);
    const link = screen.getByRole("link", { name: "nightly-backup" });
    expect(link).toHaveAttribute("href", "/side/nightly-backup");
  });

  it("hides Organization, Outages, and Longest on phone", () => {
    render(<LongestBrokenTable rows={[brokenRow()]} />);
    const headers = screen.getAllByRole("columnheader");
    const [cells] = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell"));
    for (const name of ["Organization", "Outages", "Longest"]) {
      const index = headers.findIndex((header) => header.textContent === name);
      expect(headers[index]).toHaveClass("hidden", "sm:table-cell");
      expect(cells[index]).toHaveClass("hidden", "sm:table-cell");
    }
    for (const name of ["Check", "Time broken", "Uptime"]) {
      const index = headers.findIndex((header) => header.textContent === name);
      expect(headers[index]).not.toHaveClass("hidden");
      expect(cells[index]).not.toHaveClass("hidden");
    }
  });

  it("shows the top 10 by default", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      brokenRow({ check: { id: `c${index}`, name: `check-${index}`, slug: `check-${index}` } }),
    );
    render(<LongestBrokenTable rows={rows} />);
    expect(screen.getAllByRole("row")).toHaveLength(11);
    expect(screen.queryByText("check-10")).toBeNull();
  });
});
