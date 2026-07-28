import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { usePollWhenVisible } from "@/lib/use-poll-when-visible";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("usePollWhenVisible", () => {
  beforeEach(() => setVisibility("visible"));

  it("starts polling at the given interval on mount", () => {
    const query = { startPolling: vi.fn(), stopPolling: vi.fn() };
    renderHook(() => usePollWhenVisible(query, 15_000));

    expect(query.startPolling).toHaveBeenCalledWith(15_000);
  });

  it("stops polling when the tab is hidden", () => {
    const query = { startPolling: vi.fn(), stopPolling: vi.fn() };
    renderHook(() => usePollWhenVisible(query, 15_000));

    setVisibility("hidden");

    expect(query.stopPolling).toHaveBeenCalled();
  });

  it("resumes polling when the tab becomes visible again", () => {
    const query = { startPolling: vi.fn(), stopPolling: vi.fn() };
    renderHook(() => usePollWhenVisible(query, 15_000));

    setVisibility("hidden");
    query.startPolling.mockClear();
    setVisibility("visible");

    expect(query.startPolling).toHaveBeenCalledWith(15_000);
  });

  it("does not start polling when mounted into an already-hidden tab", () => {
    setVisibility("hidden");
    const query = { startPolling: vi.fn(), stopPolling: vi.fn() };
    renderHook(() => usePollWhenVisible(query, 15_000));

    expect(query.startPolling).not.toHaveBeenCalled();
  });

  it("stops polling on unmount, so a navigated-away page leaves no timer behind", () => {
    const query = { startPolling: vi.fn(), stopPolling: vi.fn() };
    const { unmount } = renderHook(() => usePollWhenVisible(query, 15_000));

    query.stopPolling.mockClear();
    unmount();

    expect(query.stopPolling).toHaveBeenCalled();
  });

  it("detaches its listener on unmount", () => {
    const query = { startPolling: vi.fn(), stopPolling: vi.fn() };
    const { unmount } = renderHook(() => usePollWhenVisible(query, 15_000));

    unmount();
    query.startPolling.mockClear();
    query.stopPolling.mockClear();
    setVisibility("hidden");
    setVisibility("visible");

    expect(query.startPolling).not.toHaveBeenCalled();
    expect(query.stopPolling).not.toHaveBeenCalled();
  });
});
