import { fireEvent, render, screen } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_OVERVIEW } from "@/lib/queries";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import OverviewPage from "./page";

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  pollWhenVisible: vi.fn(),
}));

vi.mock("@/lib/use-poll-when-visible", () => ({
  usePollWhenVisible: nav.pollWhenVisible,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams("range=7d"),
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
    brokenSeconds: 108000,
    ongoing: true,
    check: { __typename: "CheckModel", id: "c9", name: "nightly-backup", slug: "nightly-backup" },
  },
};

function mockWith(overview: Record<string, unknown>) {
  return {
    request: { query: ACCOUNT_OVERVIEW, variables: { range: "WEEK", timeZone: "UTC" } },
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

function renderPage(overview: Record<string, unknown> = {}) {
  return render(
    <MockedProvider mocks={[mockWith(overview)]}>
      <OverviewPage />
    </MockedProvider>,
  );
}

describe("OverviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
