import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_OVERVIEW } from "@/lib/queries";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import OverviewPage from "./page";

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  pollWhenVisible: vi.fn(),
  search: "range=7d",
}));

vi.mock("@/lib/use-poll-when-visible", () => ({
  usePollWhenVisible: nav.pollWhenVisible,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const org = { __typename: "OverviewOrganization", id: "o1", name: "Acme Prod", slug: "acme" };

function entry(
  state: "DOWN" | "LATE",
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  return {
    __typename: "BrokenCheck",
    state,
    since: state === "DOWN" ? ago(3 * 3600_000) : ago(6 * 60_000),
    downAt: state === "DOWN" ? null : new Date(Date.now() + 9 * 60_000).toISOString(),
    reason: state === "DOWN" ? "HTTP 503" : null,
    check: {
      __typename: "CheckModel",
      id,
      name,
      slug: name,
      type: state === "DOWN" ? "HTTP" : "HEARTBEAT",
      status: state,
      lastEventAt: null,
      description: state === "DOWN" ? "Restart the webhook worker." : null,
    },
    organization: org,
    ...extra,
  };
}

const summary = {
  __typename: "OverviewSummary",
  uptimePercent: 99.7577,
  brokenSeconds: 150720,
  outageCount: 14,
  ongoingCount: 2,
  medianOutageSeconds: 1080,
  longestOutage: {
    __typename: "CheckBrokenTime",
    // The check's total broken time and "has any open outage" flag; the tile
    // must show the longest single span instead.
    brokenSeconds: 111900,
    ongoing: true,
    longestOutageSeconds: 108000,
    check: { __typename: "CheckModel", id: "c9", name: "nightly-backup", slug: "nightly-backup" },
    outages: [
      { __typename: "OutageSpan", startedAt: "2026-11-02T18:00:00.000Z", endedAt: null },
      {
        __typename: "OutageSpan",
        startedAt: "2026-10-30T00:00:00.000Z",
        endedAt: "2026-10-30T01:05:00.000Z",
      },
    ],
  },
};

function longestOutageTile() {
  return screen.getByText("Longest outage").closest<HTMLElement>('[data-slot="card"]')!;
}

function mockWith(
  overview: Record<string, unknown>,
  { range = "WEEK", delay }: { range?: string; delay?: number } = {},
) {
  return {
    request: { query: ACCOUNT_OVERVIEW, variables: { range, timeZone: "UTC" } },
    delay,
    result: {
      data: {
        accountOverview: {
          __typename: "AccountOverview",
          organizationCount: 3,
          checkCount: 24,
          rangeStart: "2026-10-28T00:00:00.000Z",
          rangeEnd: "2026-11-04T00:00:00.000Z",
          needsFixing: [],
          summary,
          buckets: [],
          byOrganization: [],
          checks: [],
          ...overview,
        },
      },
    },
  };
}

function errorMock(message: string) {
  return {
    request: { query: ACCOUNT_OVERVIEW, variables: { range: "WEEK", timeZone: "UTC" } },
    error: new Error(message),
  };
}

type Mock = ReturnType<typeof mockWith> | ReturnType<typeof errorMock>;

function renderWith(mocks: Mock[]) {
  const tree = () => (
    <MockedProvider mocks={mocks}>
      <OverviewPage />
    </MockedProvider>
  );
  const view = render(tree());
  return { ...view, rerenderPage: () => view.rerender(tree()) };
}

function renderPage(overview: Record<string, unknown> = {}) {
  return renderWith([mockWith(overview)]);
}

/** Re-runs the query the way a poll does; the page passes its query to the poller. */
async function poll() {
  const query = nav.pollWhenVisible.mock.lastCall![0] as { refetch: () => Promise<unknown> };
  await act(async () => {
    await query.refetch().catch(() => undefined);
  });
}

const brokenCheck = {
  __typename: "CheckBrokenTime",
  brokenSeconds: 111900,
  outageCount: 2,
  longestOutageSeconds: 108000,
  ongoing: true,
  uptimePercent: 95.6789,
  check: { __typename: "CheckModel", id: "c9", name: "nightly-backup", slug: "nightly-backup" },
  organization: { ...org, id: "o2", name: "Side Projects", slug: "side" },
  outages: [
    { __typename: "OutageSpan", startedAt: "2026-11-03T00:00:00.000Z", endedAt: null },
  ],
};

describe("OverviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.search = "range=7d";
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "UTC",
    } as Intl.ResolvedDateTimeFormatOptions);
  });

  it("requests the range from the URL and the browser time zone", async () => {
    renderPage();
    // The mock only matches WEEK/UTC, so rendering the data proves the variables.
    expect(await screen.findByText("Last 7 days, all organizations")).toBeTruthy();
    expect(screen.getByText("All your organizations · 3 organizations · 24 checks")).toBeTruthy();
  });

  it("lists broken checks with organization, duration, and fix note", async () => {
    renderPage({
      needsFixing: [
        entry("DOWN", "c1", "billing-webhook"),
        entry("LATE", "c2", "etl-sync"),
      ],
    });
    const link = await screen.findByRole("link", { name: "billing-webhook" });
    expect(link.getAttribute("href")).toBe("/acme/billing-webhook");
    expect(screen.getAllByText("Acme Prod").length).toBe(2);
    expect(screen.getByText("down for")).toBeTruthy();
    expect(screen.getByText("How to fix:")).toBeTruthy();
    expect(screen.getByText(/Restart the webhook worker\./)).toBeTruthy();
    expect(screen.getByText("late by")).toBeTruthy();
    expect(screen.getByText("DOWN")).toBeTruthy();
    expect(screen.getByText("LATE")).toBeTruthy();
  });

  it("shows summary tiles", async () => {
    renderPage();
    expect(await screen.findByText("99.76%")).toBeTruthy();
    expect(screen.getByText("across 24 checks")).toBeTruthy();
    expect(screen.getByText("2 still ongoing")).toBeTruthy();
    expect(screen.getByText("18m")).toBeTruthy();
  });

  it("shows the longest single outage, not the check's total broken time", async () => {
    // nightly-backup was broken 1d 7h in total; its longest single outage was 1d 6h.
    renderPage({ checks: [brokenCheck] });
    await screen.findByText("99.76%");
    const tile = within(longestOutageTile());
    expect(tile.getByText("1d 6h")).toBeTruthy();
    expect(tile.queryByText("1d 7h")).toBeNull();
    expect(tile.getByText(", ongoing")).toBeTruthy();
  });

  it("does not call the longest outage ongoing when only a shorter one is open", async () => {
    renderPage({
      summary: {
        ...summary,
        longestOutage: {
          ...summary.longestOutage,
          outages: [
            {
              __typename: "OutageSpan",
              startedAt: "2026-10-30T00:00:00.000Z",
              endedAt: "2026-10-31T06:00:00.000Z",
            },
            { __typename: "OutageSpan", startedAt: "2026-11-03T23:50:00.000Z", endedAt: null },
          ],
        },
      },
    });
    await screen.findByText("99.76%");
    const tile = within(longestOutageTile());
    expect(tile.getByText("nightly-backup")).toBeTruthy();
    expect(tile.queryByText(", ongoing")).toBeNull();
  });

  it("shows \"Nothing needs fixing\" when nothing is broken", async () => {
    renderPage();
    expect(await screen.findByText("Nothing needs fixing")).toBeTruthy();
  });

  it("shows the no-checks empty state", async () => {
    renderPage({ checkCount: 0 });
    const link = await screen.findByRole("link", { name: "Go to the dashboard" });
    expect(link.getAttribute("href")).toBe("/dashboard");
  });

  it("changes the range through the URL", async () => {
    renderPage();
    await screen.findByText("Nothing needs fixing");
    fireEvent.click(screen.getByRole("button", { name: "90d" }));
    expect(nav.replace).toHaveBeenCalledWith("/overview?range=90d");
  });

  it("polls while visible", async () => {
    renderPage();
    await screen.findByText("Nothing needs fixing");
    expect(nav.pollWhenVisible).toHaveBeenCalledWith(
      expect.anything(),
      CHECK_POLL_INTERVAL_MS,
    );
  });

  it("charts broken time, outages, and the longest-broken checks", async () => {
    renderPage({
      buckets: [
        { __typename: "BrokenTimeBucket", start: "2026-11-03T00:00:00.000Z", brokenSeconds: 86400 },
      ],
      byOrganization: [
        {
          __typename: "OrganizationBrokenTime",
          brokenSeconds: 111900,
          outageCount: 2,
          organization: brokenCheck.organization,
        },
      ],
      checks: [brokenCheck],
    });
    expect(await screen.findByRole("figure", { name: "Time broken per day" })).toBeTruthy();
    expect(screen.getByText("Time broken by organization")).toBeTruthy();
    expect(screen.getByText("Outages, last 7 days")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Legend" })).toBeTruthy();
    expect(screen.getByText("Checks broken the longest")).toBeTruthy();
    expect(screen.getByRole("link", { name: "nightly-backup" }).getAttribute("href")).toBe(
      "/side/nightly-backup",
    );
  });

  it("shows one calm line when there were no outages", async () => {
    renderPage({
      checks: [],
      summary: {
        ...summary,
        uptimePercent: 100,
        brokenSeconds: 0,
        outageCount: 0,
        ongoingCount: 0,
        medianOutageSeconds: null,
        longestOutage: null,
      },
    });
    expect(await screen.findByText("No outages in the last 7 days")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Legend" })).toBeNull();
    expect(screen.queryByText("Down")).toBeNull();
    expect(screen.queryByText("Checks broken the longest")).toBeNull();
  });

  it("keeps the previous range on screen while the next one loads", async () => {
    nav.replace.mockImplementation((url: string) => {
      nav.search = url.split("?")[1];
    });
    const month = mockWith(
      {
        rangeStart: "2026-10-05T00:00:00.000Z",
        rangeEnd: "2026-11-04T00:00:00.000Z",
        summary: { ...summary, uptimePercent: 98.5 },
      },
      { range: "MONTH", delay: 30 },
    );
    const { rerenderPage, container } = renderWith([mockWith({}), month]);
    expect(await screen.findByText("99.76%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    rerenderPage();

    // The 7-day numbers stay up, still labelled as 7 days, instead of the skeleton.
    expect(screen.getByRole("button", { name: "30d" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("99.76%")).toBeTruthy();
    expect(screen.getByText("Last 7 days, all organizations")).toBeTruthy();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    expect(await screen.findByText("98.50%")).toBeTruthy();
    expect(screen.queryByText("99.76%")).toBeNull();
    expect(screen.getByText("Last 30 days, all organizations")).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("does not reopen a dismissed error when the same error repeats", async () => {
    renderWith([
      errorMock("Network down"),
      errorMock("Network down"),
      errorMock("Gateway timeout"),
    ]);
    expect(await screen.findByText("Could not load the overview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("Could not load the overview")).toBeNull());

    await poll();
    expect(screen.queryByText("Could not load the overview")).toBeNull();

    // A different failure is news, so it is reported.
    await poll();
    expect(await screen.findByText("Could not load the overview")).toBeTruthy();
  });
});
