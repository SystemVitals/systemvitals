import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Wordmark } from "./wordmark";

describe("Wordmark", () => {
  it("renders the product name and links home by default", () => {
    render(<Wordmark />);
    expect(screen.getByText("SystemVitals")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/");
  });
});
