import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Heartbeat } from "./heartbeat";

describe("Heartbeat", () => {
  it("renders an svg EKG trace with a polyline/path", () => {
    const { container } = render(<Heartbeat />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("path, polyline")).toBeTruthy();
  });
  it("marks the trace decorative for screen readers", () => {
    const { container } = render(<Heartbeat />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
