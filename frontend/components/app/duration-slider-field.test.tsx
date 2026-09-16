import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DurationSliderField } from "./duration-slider-field";

function Harness({
  initialMs = 5000,
  minMs = 1000,
  maxMs = 60000,
  stepMs = 500,
}: {
  initialMs?: number;
  minMs?: number;
  maxMs?: number;
  stepMs?: number;
}) {
  const [ms, setMs] = useState(initialMs);
  return (
    <>
      <DurationSliderField
        id="timeout"
        label="Timeout"
        valueMs={ms}
        onValueMsChange={setMs}
        minMs={minMs}
        maxMs={maxMs}
        stepMs={stepMs}
      />
      <output>{ms}</output>
    </>
  );
}

describe("DurationSliderField", () => {
  it("lets the user type seconds or drag the slider for the same millisecond value", () => {
    render(<Harness />);

    const input = screen.getByLabelText("Timeout");
    const slider = screen.getByRole("slider", { hidden: true });

    expect(input).toHaveValue(5);
    expect(slider).toHaveValue("5000");

    fireEvent.change(input, { target: { value: "12" } });
    expect(input).toHaveValue(12);
    expect(slider).toHaveValue("12000");
    expect(screen.getByRole("status")).toHaveTextContent("12000");

    fireEvent.change(slider, { target: { value: "3500" } });
    expect(input).toHaveValue(3.5);
    expect(slider).toHaveValue("3500");
    expect(screen.getByRole("status")).toHaveTextContent("3500");
  });

  it("clamps a typed value to the slider range on blur", () => {
    render(<Harness />);

    const input = screen.getByLabelText("Timeout");

    fireEvent.change(input, { target: { value: "90" } });
    expect(input).toHaveValue(90);
    fireEvent.blur(input);
    expect(input).toHaveValue(60);
    expect(screen.getByRole("status")).toHaveTextContent("60000");

    fireEvent.change(input, { target: { value: "0" } });
    expect(input).toHaveValue(0);
    fireEvent.blur(input);
    expect(input).toHaveValue(1);
    expect(screen.getByRole("status")).toHaveTextContent("1000");
  });

  it("does not offer minute or hour units for a timeout-scale range", () => {
    render(<Harness />);

    expect(screen.queryByRole("button", { name: "Minutes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hours" })).not.toBeInTheDocument();
  });

  it("opens a 5-minute value in minutes and converts when the unit changes", () => {
    render(
      <Harness initialMs={300000} minMs={60000} maxMs={86400000} stepMs={1000} />,
    );

    const input = screen.getByLabelText("Timeout");
    expect(input).toHaveValue(5);
    expect(screen.getByRole("button", { name: "Minutes" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Seconds" }));
    expect(input).toHaveValue(300);
    expect(screen.getByRole("status")).toHaveTextContent("300000");

    fireEvent.click(screen.getByRole("button", { name: "Hours" }));
    expect(input).toHaveValue(300 / 3600);
    expect(screen.getByRole("status")).toHaveTextContent("300000");
  });

  it("commits a value typed in minutes", () => {
    render(
      <Harness initialMs={300000} minMs={60000} maxMs={86400000} stepMs={1000} />,
    );

    const input = screen.getByLabelText("Timeout");
    fireEvent.change(input, { target: { value: "10" } });
    expect(screen.getByRole("status")).toHaveTextContent("600000");
  });

  it("lets the user type a value above a high minimum before blur", () => {
    render(
      <Harness initialMs={300000} minMs={300000} maxMs={86400000} stepMs={1000} />,
    );

    const input = screen.getByLabelText("Timeout");
    expect(input).toHaveValue(5);

    fireEvent.change(input, { target: { value: "1" } });
    expect(input).toHaveValue(1);
    expect(screen.getByRole("status")).toHaveTextContent("300000");
    fireEvent.change(input, { target: { value: "10" } });
    expect(input).toHaveValue(10);
    fireEvent.blur(input);
    expect(input).toHaveValue(10);
    expect(screen.getByRole("status")).toHaveTextContent("600000");
  });
});
