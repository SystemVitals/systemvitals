import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import { ApolloClient, ApolloLink, InMemoryCache, Observable } from "@apollo/client";
import { ApolloProvider } from "@apollo/client/react";
import { EditCheckDialog } from "@/components/app/edit-check-dialog";
import { MY_SUBSCRIPTION } from "@/lib/queries";

const orgContext = vi.hoisted(() => ({ plan: "SIGNAL" }));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({
    activeOrg: { plan: orgContext.plan },
    orgs: [
      {
        plan: "SIGNAL",
        projects: [{ id: "project-signal" }],
      },
      {
        plan: "SOLO",
        projects: [{ id: "project-solo" }],
      },
    ],
  }),
}));

// `typeof HEARTBEAT` would infer literal types (e.g. `periodSeconds: number`)
// from these initial values, making `HTTP` below — which legitimately swaps
// several of these to `null` vs. a real value — structurally incompatible
// with it under `tsc --noEmit`. An explicit nullable-field type keeps both
// fixtures (and `renderDialog`'s parameter) honest without changing any
// runtime value or assertion.
interface CheckFixture {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  type: string;
  periodSeconds: number | null;
  graceSeconds: number | null;
  schedule: string | null;
  tz: string | null;
  target: string | null;
  method: string | null;
  expectedStatus: number | null;
  intervalSeconds: number | null;
  timeoutMs: number | null;
}

const HEARTBEAT: CheckFixture = {
  id: "c1",
  projectId: "project-signal",
  name: "Nightly job",
  slug: "nightly-job",
  type: "HEARTBEAT",
  periodSeconds: 300,
  graceSeconds: 60,
  schedule: null,
  tz: null,
  target: null,
  method: null,
  expectedStatus: null,
  intervalSeconds: null,
  timeoutMs: null,
};

const HTTP: CheckFixture = {
  ...HEARTBEAT,
  type: "HTTP",
  periodSeconds: null,
  graceSeconds: null,
  target: "https://example.com/health",
  method: "GET",
  expectedStatus: 200,
  intervalSeconds: 300,
  timeoutMs: 5000,
};

const CRON_HEARTBEAT: CheckFixture = {
  ...HEARTBEAT,
  periodSeconds: null,
  schedule: "0 3 * * *",
  tz: "UTC",
};

function subscriptionMock(plan = "SIGNAL") {
  return {
    request: { query: MY_SUBSCRIPTION },
    result: {
      data: {
        mySubscription: {
          plan,
          status: "active",
          checkCount: 1,
          maxChecks: 100,
          organizationCount: 1,
        },
      },
    },
  };
}

function renderDialog(check: CheckFixture, plan = "SIGNAL") {
  return render(
    <MockedProvider mocks={[subscriptionMock(plan)]}>
      <EditCheckDialog open check={check} onOpenChange={() => {}} onSaved={() => {}} />
    </MockedProvider>
  );
}

/**
 * `MockedProvider` matches mocks against exact variables, which makes it
 * awkward to *inspect* what a submit actually sent. Instead, wrap the dialog
 * in a real `ApolloClient` whose link records each operation's variables and
 * resolves with a minimally-shaped `updateCheck` payload satisfying
 * `UPDATE_CHECK`'s selection set (see `api/src/checks/check.model.ts` for the
 * nullability those fields allow).
 */
function renderDialogCapturingVariables(check: CheckFixture, plan = "SIGNAL") {
  const captured: Record<string, unknown>[] = [];
  const link = new ApolloLink((operation) => {
    if (operation.operationName === "mySubscription") {
      return new Observable((observer) => {
        observer.next({ data: subscriptionMock(plan).result.data });
        observer.complete();
      });
    }

    captured.push(operation.variables);
    return new Observable((observer) => {
      observer.next({
        data: {
          updateCheck: {
            __typename: "Check",
            id: check.id,
            name: check.name,
            slug: check.slug,
            type: check.type,
            status: "UP",
            pingSlug: null,
            periodSeconds: null,
            graceSeconds: null,
            schedule: null,
            tz: null,
            target: null,
            method: null,
            expectedStatus: null,
            intervalSeconds: null,
            timeoutMs: null,
          },
        },
      });
      observer.complete();
    });
  });
  const client = new ApolloClient({ link, cache: new InMemoryCache() });

  const utils = render(
    <ApolloProvider client={client}>
      <EditCheckDialog open check={check} onOpenChange={() => {}} onSaved={() => {}} />
    </ApolloProvider>
  );

  return { ...utils, captured };
}

// The dialog content is rendered into a Radix portal appended to
// `document.body`, not into the `container` div `render()` returns, so the
// form must be looked up against the document.
async function waitForPlan() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  );
}

function submitForm() {
  const form = document.querySelector("form");
  if (!form) throw new Error("form not found");
  fireEvent.submit(form);
}

describe("EditCheckDialog", () => {
  beforeEach(() => {
    orgContext.plan = "SIGNAL";
  });

  it("prefills the current name", () => {
    renderDialog(HEARTBEAT);
    expect(screen.getByLabelText(/name/i)).toHaveValue("Nightly job");
  });

  it("shows heartbeat timing fields for a heartbeat check", () => {
    renderDialog(HEARTBEAT);
    expect(screen.getByLabelText(/period/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/grace/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/target/i)).not.toBeInTheDocument();
  });

  it("shows target fields for an active check", () => {
    renderDialog(HTTP);
    expect(screen.getByLabelText(/target/i)).toHaveValue("https://example.com/health");
    expect(screen.getByLabelText(/interval/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/period/i)).not.toBeInTheDocument();
  });

  it("uses the paid plan floor for heartbeat periods and active intervals", async () => {
    const { unmount } = renderDialog(HEARTBEAT);
    await waitFor(() =>
      expect(screen.getByLabelText(/period/i)).toHaveAttribute("min", "60")
    );

    unmount();
    renderDialog(HTTP);
    await waitFor(() =>
      expect(screen.getByLabelText(/interval/i)).toHaveAttribute("min", "60")
    );
  });

  it("uses the SIGNAL creator floor for a SOLO collaborator", async () => {
    orgContext.plan = "SIGNAL";
    renderDialog(HEARTBEAT, "SOLO");

    await waitForPlan();
    await waitFor(() =>
      expect(screen.getByLabelText(/period/i)).toHaveAttribute("min", "60")
    );
  });

  it("uses the SOLO creator floor for a SIGNAL collaborator", async () => {
    orgContext.plan = "SOLO";
    renderDialog({ ...HTTP, projectId: "project-solo" }, "SIGNAL");

    await waitForPlan();
    await waitFor(() =>
      expect(screen.getByLabelText(/interval/i)).toHaveAttribute("min", "300")
    );
  });

  it("uses the check owner's plan when the active organization differs", async () => {
    orgContext.plan = "SOLO";
    renderDialog(HEARTBEAT, "SOLO");

    await waitForPlan();
    expect(screen.getByLabelText(/period/i)).toHaveAttribute("min", "60");
  });

  it("allows unrelated edits to an unchanged grandfathered cadence", async () => {
    const grandfathered = { ...HTTP, intervalSeconds: 30 };
    const { captured } = renderDialogCapturingVariables(grandfathered);

    await waitForPlan();
    await waitFor(() =>
      expect(screen.getByLabelText(/interval/i)).toHaveAttribute("min", "30")
    );
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: "Renamed health check" },
    });
    submitForm();

    await waitFor(() => expect(captured).toHaveLength(1));
    const input = captured[0].input as Record<string, unknown>;
    expect(input.name).toBe("Renamed health check");
    expect(input.intervalSeconds).toBe(30);
  });

  it("rejects a changed grandfathered cadence below the paid plan floor", async () => {
    const grandfathered = { ...HTTP, intervalSeconds: 30 };
    const { captured } = renderDialogCapturingVariables(grandfathered);

    await waitForPlan();
    fireEvent.change(screen.getByLabelText(/interval/i), {
      target: { value: "45" },
    });
    submitForm();

    expect(
      await screen.findByText("Interval must be at least 60 seconds.")
    ).toBeInTheDocument();
    expect(captured).toHaveLength(0);
  });

  it("rejects a type conversion that retains a grandfathered cadence", async () => {
    const grandfathered = { ...HTTP, intervalSeconds: 30 };
    const { captured } = renderDialogCapturingVariables(grandfathered);

    await waitForPlan();
    fireEvent.click(screen.getByRole("button", { name: /^tcp$/i }));
    submitForm();

    expect(
      await screen.findByText("Interval must be at least 60 seconds.")
    ).toBeInTheDocument();
    expect(captured).toHaveLength(0);
  });

  it("clears the target when crossing the HTTP -> TCP boundary, so a stale URL can't masquerade as host:port", () => {
    renderDialog(HTTP);
    expect(screen.getByLabelText(/target/i)).toHaveValue("https://example.com/health");

    fireEvent.click(screen.getByRole("button", { name: /^tcp$/i }));

    expect(screen.getByLabelText(/target/i)).toHaveValue("");
  });

  it("clears the target when crossing the TCP -> HTTP boundary", () => {
    const TCP = { ...HTTP, type: "TCP", target: "example.com:5432", method: null, expectedStatus: null };
    renderDialog(TCP);
    expect(screen.getByLabelText(/target/i)).toHaveValue("example.com:5432");

    fireEvent.click(screen.getByRole("button", { name: /^http$/i }));

    expect(screen.getByLabelText(/target/i)).toHaveValue("");
  });

  it("does not clear the target when re-selecting the same active type", () => {
    renderDialog(HTTP);
    fireEvent.click(screen.getByRole("button", { name: /^http$/i }));
    expect(screen.getByLabelText(/target/i)).toHaveValue("https://example.com/health");
  });

  it("keeps the target field required after it is cleared by a type crossing", () => {
    renderDialog(HTTP);
    fireEvent.click(screen.getByRole("button", { name: /^tcp$/i }));
    expect(screen.getByLabelText(/target/i)).toBeRequired();
  });

  it("offers only the types that have a prober, as a labelled toggle group", () => {
    renderDialog(HEARTBEAT);
    // The type picker is a row of buttons (matching `CreateCheckDialog`'s
    // pattern), not a native `<select>` — query it the same way a user
    // would, by accessible name.
    const typeButtons = screen.getAllByRole("button", { name: /^(heartbeat|http|tcp)$/i });
    expect(typeButtons.map((b) => b.textContent)).toEqual(["Heartbeat", "HTTP", "TCP"]);
    expect(screen.queryByRole("button", { name: /^ping$/i })).not.toBeInTheDocument();

    // Selected state must be conveyed non-visually, not by colour alone.
    const selected = typeButtons.find((b) => b.textContent === "Heartbeat");
    expect(selected).toHaveAttribute("aria-pressed", "true");
    const unselected = typeButtons.filter((b) => b !== selected);
    for (const b of unselected) {
      expect(b).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("prefills the current slug", () => {
    renderDialog(HEARTBEAT);
    expect(screen.getByLabelText(/url slug/i)).toHaveValue("nightly-job");
  });

  it("does not send slug in the variables when it is left unchanged", async () => {
    const { captured } = renderDialogCapturingVariables(HEARTBEAT);
    await waitForPlan();
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Renamed job" } });
    submitForm();

    await waitFor(() => expect(captured).toHaveLength(1));
    const [variables] = captured;
    const input = variables.input as Record<string, unknown>;
    expect(input).not.toHaveProperty("slug");
  });

  it("sends the new slug in the variables when it is changed", async () => {
    const { captured } = renderDialogCapturingVariables(HEARTBEAT);
    await waitForPlan();
    fireEvent.change(screen.getByLabelText(/url slug/i), { target: { value: "renamed-slug" } });
    submitForm();

    await waitFor(() => expect(captured).toHaveLength(1));
    const [variables] = captured;
    const input = variables.input as Record<string, unknown>;
    expect(input.slug).toBe("renamed-slug");
  });

  it("sends only name+period+grace for a name-only edit on a heartbeat", async () => {
    const { captured } = renderDialogCapturingVariables(HEARTBEAT);
    await waitForPlan();
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Renamed job" } });
    submitForm();

    await waitFor(() => expect(captured).toHaveLength(1));
    const [variables] = captured;
    expect(variables.id).toBe("c1");

    const input = variables.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["graceSeconds", "name", "periodSeconds"].sort());
    expect(input.name).toBe("Renamed job");
    expect(input.periodSeconds).toBe(300);
    expect(input.graceSeconds).toBe(60);
    expect(Object.values(input)).not.toContain(null);
  });

  it("sends type + only HTTP-relevant fields on a HEARTBEAT -> HTTP conversion", async () => {
    const { captured } = renderDialogCapturingVariables(HEARTBEAT);
    await waitForPlan();
    fireEvent.click(screen.getByRole("button", { name: /^http$/i }));
    fireEvent.change(screen.getByLabelText(/target/i), {
      target: { value: "https://example.com/health" },
    });
    submitForm();

    await waitFor(() => expect(captured).toHaveLength(1));
    const [variables] = captured;
    expect(variables.id).toBe("c1");

    const input = variables.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(
      ["name", "type", "target", "intervalSeconds", "timeoutMs", "method"].sort()
    );
    expect(input.type).toBe("HTTP");
    expect(input.target).toBe("https://example.com/health");
    // Neither periodSeconds/graceSeconds/schedule/tz (the outgoing
    // heartbeat's fields) belong in the new mode's payload.
    expect(input).not.toHaveProperty("periodSeconds");
    expect(input).not.toHaveProperty("graceSeconds");
    expect(input).not.toHaveProperty("schedule");
    expect(input).not.toHaveProperty("tz");
    expect(Object.values(input)).not.toContain(null);
  });

  it("sends schedule+tz, never periodSeconds, for a cron-mode heartbeat submission", async () => {
    const { captured } = renderDialogCapturingVariables(CRON_HEARTBEAT);
    await waitForPlan();
    submitForm();

    await waitFor(() => expect(captured).toHaveLength(1));
    const [variables] = captured;
    expect(variables.id).toBe("c1");

    const input = variables.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["graceSeconds", "name", "schedule", "tz"].sort());
    expect(input.schedule).toBe("0 3 * * *");
    expect(input.tz).toBe("UTC");
    expect(input).not.toHaveProperty("periodSeconds");
    expect(Object.values(input)).not.toContain(null);
  });
});
