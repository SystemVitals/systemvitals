import { formatElapsed } from "@/lib/format";

export type EventStatus = "UP" | "DOWN" | "GRACE";

export interface TimelineEvent {
  id: string;
  status: EventStatus;
  timestamp: string;
  error: string | null;
  responseTimeMs: number | null;
  statusCode: number | null;
  sourceIp: string | null;
}

const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  UP: "Up",
  DOWN: "Down",
  GRACE: "Grace",
};

const EVENT_DOT_COLORS: Record<EventStatus, string> = {
  UP: "bg-success",
  DOWN: "bg-destructive",
  GRACE: "bg-warning",
};

/**
 * Timestamps are rendered truncated to the second, so gaps are measured at that
 * same precision. Using the stored milliseconds instead makes a label disagree
 * with the only arithmetic a reader can do — two events shown a second apart
 * would be labelled from a span the screen never revealed.
 */
function atRenderedPrecision(timestamp: string): number {
  return Math.floor(new Date(timestamp).getTime() / 1000) * 1000;
}

/**
 * Events arrive newest-first, so the gap belonging to the connector below an
 * event is the distance back to the *next* entry in the list.
 */
function gapBelow(events: TimelineEvent[], index: number): string | null {
  const older = events[index + 1];
  if (!older) return null;
  return formatElapsed(
    atRenderedPrecision(events[index].timestamp) - atRenderedPrecision(older.timestamp),
  );
}

export function EventTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }

  return (
    <ul className="relative space-y-0">
      {events.map((event, index) => {
        const gap = gapBelow(events, index);
        return (
          <li key={event.id} className="relative pl-8 pb-4 last:pb-0">
            {/* Connector, drawn only where another event follows below. */}
            {gap && <span className="absolute left-[7px] top-5 bottom-0 w-px bg-border" aria-hidden />}

            <span
              className={`absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-background ${EVENT_DOT_COLORS[event.status]}`}
            />

            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold">{EVENT_STATUS_LABELS[event.status]}</span>
              <span className="text-sm text-muted-foreground">
                {new Date(event.timestamp).toLocaleString()}
              </span>
            </div>
            {event.sourceIp && (
              <p className="text-xs font-mono text-muted-foreground mt-0.5">{event.sourceIp}</p>
            )}
            {event.statusCode !== null && (
              <p className="text-xs text-muted-foreground mt-0.5">HTTP {event.statusCode}</p>
            )}
            {event.responseTimeMs !== null && (
              <p className="text-xs text-muted-foreground mt-0.5">{event.responseTimeMs}ms</p>
            )}
            {event.error && (
              <p className="text-xs text-destructive mt-0.5 truncate">{event.error}</p>
            )}

            {/* The gap hangs off the connector, so it reads as a property of the
                interval rather than of either event it sits between. */}
            {gap && (
              <div className="relative flex items-center pt-3">
                <span className="absolute left-[-25px] w-5 h-px bg-border" aria-hidden />
                <span className="text-[11px] tabular-nums text-muted-foreground">{gap}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
