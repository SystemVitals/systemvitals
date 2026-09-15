import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DurationSliderField } from "./duration-slider-field";

function Harness({ initialMs = 5000 }: { initialMs?: number }) {
  const [ms, setMs] = useState(initialMs);
  return (
    <>
      <DurationSliderField
        id="timeout"
        label="Timeout"
        valueMs={ms}
        onValueMsChange={setMs}
        minMs={1000}
        maxMs={60000}
        stepMs={500}
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
    fireEvent.blur(input);
    expect(input).toHaveValue(60);
    expect(screen.getByRole("status")).toHaveTextContent("60000");

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(input).toHaveValue(1);
    expect(screen.getByRole("status")).toHaveTextContent("1000");
  });
});
