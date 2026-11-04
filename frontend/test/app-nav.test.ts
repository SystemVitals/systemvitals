import { describe, expect, it } from "vitest";
import { LayoutGrid } from "lucide-react";
import { APP_NAV_SECTIONS } from "@/components/app/sidebar";

describe("app navigation", () => {
  it("starts with the account-wide Overview", () => {
    expect(APP_NAV_SECTIONS[0]).toEqual({
      label: "All organizations",
      items: [{ label: "Overview", href: "/overview", icon: LayoutGrid }],
    });
  });
});
