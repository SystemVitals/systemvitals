import { expect, it, vi } from "vitest";
import AgentConnectionsRoute from "./page";
const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));
it("redirects the retired agent page to Account token controls", () => {
  AgentConnectionsRoute();
  expect(redirect).toHaveBeenCalledWith("/account#personal-access-tokens");
});
