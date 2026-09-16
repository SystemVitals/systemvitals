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

  it("lets the user type a value above a high minimum before blur", () => {
    render(<Harness initialMs={300000} minMs={300000} maxMs={86400000} stepMs={1000} />);

    const input = screen.getByLabelText("Timeout");
    expect(input).toHaveValue(300);

    fireEvent.change(input, { target: { value: "6" } });
    expect(input).toHaveValue(6);
    fireEvent.change(input, { target: { value: "600" } });
    expect(input).toHaveValue(600);
    fireEvent.blur(input);
    expect(input).toHaveValue(600);
    expect(screen.getByRole("status")).toHaveTextContent("600000");
  });
});
