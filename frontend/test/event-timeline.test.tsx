import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventTimeline, type TimelineEvent } from "@/components/app/event-timeline";

function event(id: string, timestamp: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id,
    status: "UP",
    timestamp,
    error: null,
    responseTimeMs: null,
    statusCode: null,
    sourceIp: null,
    ...overrides,
  };
}

// The real rows from production check cmrw0i77z000lta012b6w9lut: a run of rapid
// pings, then a long silence the watchdog eventually called as DOWN. Sub-second
// components are kept verbatim — they are what made the first version of this
// component disagree with its own timestamps on screen.
const EVENTS: TimelineEvent[] = [
  event("e1", "2026-07-22T12:50:47.515Z", { status: "DOWN", error: "missed heartbeat" }),
  event("e2", "2026-07-22T11:41:58.645Z"),
  event("e3", "2026-07-22T11:41:51.775Z"),
  event("e4", "2026-07-22T11:41:50.126Z"),
  event("e5", "2026-07-22T11:41:46.812Z"),
];

describe("EventTimeline", () => {
  it("labels each interval with the gap back to the older event", () => {
    render(<EventTimeline events={EVENTS} />);

    expect(screen.getByText("1h 8m")).toBeInTheDocument();
    expect(screen.getByText("7s")).toBeInTheDocument();
    expect(screen.getByText("1s")).toBeInTheDocument();
    expect(screen.getByText("4s")).toBeInTheDocument();
  });

  it("measures gaps at the precision it renders, so labels match the times on screen", () => {
    // 11:41:58.645 - 11:41:51.775 is 6.87s, but the page shows :58 and :51.
    // A reader subtracts those and expects 7s, so that is what must be labelled.
    render(<EventTimeline events={[EVENTS[1], EVENTS[2]]} />);

    expect(screen.getByText("7s")).toBeInTheDocument();
    expect(screen.queryByText("6s")).not.toBeInTheDocument();
  });

  it("does not let sub-second drift change a label", () => {
    const a = event("a", "2026-07-22T10:00:05.999Z");
    const b = event("b", "2026-07-22T10:00:00.001Z");
    // True span is 5.998s; both render as :05 and :00, so the label reads 5s.
    render(<EventTimeline events={[a, b]} />);

    expect(screen.getByText("5s")).toBeInTheDocument();
  });

  it("renders one fewer gap than events, since the oldest has no interval below it", () => {
    const { container } = render(<EventTimeline events={EVENTS} />);
    const gaps = container.querySelectorAll("span.tabular-nums");
    expect(gaps).toHaveLength(EVENTS.length - 1);
  });

  it("reads gaps newest-to-oldest, so a reversed list would not produce these labels", () => {
    // Guards the ordering assumption: with events oldest-first every gap would
    // be negative and collapse to "<1s".
    render(<EventTimeline events={[...EVENTS].reverse()} />);
    expect(screen.getAllByText("<1s")).toHaveLength(EVENTS.length - 1);
  });

  it("renders a single event with no gap label at all", () => {
    const { container } = render(<EventTimeline events={[EVENTS[0]]} />);
    expect(container.querySelectorAll("span.tabular-nums")).toHaveLength(0);
    expect(screen.getByText("Down")).toBeInTheDocument();
  });

  it("shows an empty state when there are no events", () => {
    render(<EventTimeline events={[]} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("still renders event detail alongside the gaps", () => {
    render(<EventTimeline events={EVENTS} />);
    expect(screen.getByText("missed heartbeat")).toBeInTheDocument();
  });

  it("shows the heartbeat origin IP on received pings", () => {
    render(
      <EventTimeline
        events={[event("up", "2026-09-01T16:21:04.000Z", { sourceIp: "203.0.113.40" })]}
      />,
    );

    expect(screen.getByText("203.0.113.40")).toBeInTheDocument();
  });

  it("does not invent an origin IP for a missed heartbeat", () => {
    render(<EventTimeline events={[EVENTS[0]]} />);

    expect(screen.queryByText(/^\d{1,3}(?:\.\d{1,3}){3}$/)).not.toBeInTheDocument();
  });
});
