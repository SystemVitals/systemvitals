"use client";
import { useEffect } from "react";

interface Pollable {
  startPolling: (intervalMs: number) => void;
  stopPolling: () => void;
}

/**
 * Poll an Apollo query only while the tab is in the foreground.
 *
 * Apollo keeps polling a backgrounded tab, which means every open dashboard
 * goes on hitting the API indefinitely. Driving start/stop from
 * `visibilitychange` keeps a hidden tab quiet, and the refetch on becoming
 * visible again means the user never reads a stale value on return.
 */
export function usePollWhenVisible(query: Pollable, intervalMs: number): void {
  const { startPolling, stopPolling } = query;

  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === "visible") startPolling(intervalMs);
      else stopPolling();
    };

    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stopPolling();
    };
  }, [startPolling, stopPolling, intervalMs]);
}
