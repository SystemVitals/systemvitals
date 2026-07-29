import { ApolloClient, ApolloLink, InMemoryCache, Observable } from "@apollo/client";
import { ApolloProvider } from "@apollo/client/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { print } from "graphql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoveCheckDialog } from "@/components/app/move-check-dialog";
import { MOVE_CHECK } from "@/lib/queries";
import type { Org } from "@/lib/org-context";

const orgContext = vi.hoisted(() => ({ orgs: [] as Org[] }));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ orgs: orgContext.orgs }),
}));

const orgs = [
  {
    id: "org-source",
    name: "Source Org",
    slug: "source",
    role: "OWNER",
    plan: "SOLO",
    creatorUserId: "creator-source",
    creatorLabel: "source@example.com",
    pingKey: "source",
  },
  {
    id: "org-admin",
    name: "Admin Org",
    slug: "admin",
    role: "ADMIN",
    plan: "SOLO",
    creatorUserId: "creator-admin",
    creatorLabel: "admin@example.com",
    pingKey: "admin",
  },
  {
    id: "org-destination",
    name: "Destination Org",
    slug: "destination",
    role: "OWNER",
    plan: "SOLO",
    creatorUserId: "creator-destination",
    creatorLabel: "destination@example.com",
    pingKey: "destination",
  },
] satisfies Org[];

function renderDialog(options?: { reject?: boolean; refreshReject?: boolean }) {
  let capturedVariables: Record<string, unknown> | undefined;
  const link = new ApolloLink((operation) => {
    capturedVariables = operation.variables;
    return new Observable((observer) => {
      if (options?.reject) {
        observer.error(new Error("Destination already has that slug"));
        return;
      }
      observer.next({
        data: {
          moveCheck: {
            id: "check-1",
            organizationId: "org-destination",
            slug: "nightly-backup",
          },
        },
      });
      observer.complete();
    });
  });
  const client = new ApolloClient({ link, cache: new InMemoryCache() });
  const refetchQueries = vi.spyOn(client, "refetchQueries");
  if (options?.refreshReject) {
    refetchQueries.mockRejectedValue(new Error("Refresh failed"));
  } else {
    refetchQueries.mockResolvedValue([]);
  }
  const evict = vi.spyOn(client.cache, "evict");
  const gc = vi.spyOn(client.cache, "gc");
  const onMoved = vi.fn();

  render(
    <ApolloProvider client={client}>
      <MoveCheckDialog
        checkId="check-1"
        sourceOrganizationId="org-source"
        checkSlug="nightly-backup"
        onMoved={onMoved}
      />
    </ApolloProvider>,
  );

  return {
    getCapturedVariables: () => capturedVariables,
    onMoved,
    refetchQueries,
    evict,
    gc,
  };
}

async function selectDestination() {
  fireEvent.click(screen.getByRole("button", { name: "Move check" }));

  const selects = screen.getAllByRole("combobox");
  expect(selects).toHaveLength(1);
  fireEvent.click(selects[0]);
  fireEvent.click(await screen.findByRole("option", { name: "Destination Org" }));
}

describe("MoveCheckDialog", () => {
  beforeEach(() => {
    orgContext.orgs = orgs;
  });

  it("declares the move mutation result and arguments", () => {
    const query = print(MOVE_CHECK);
    expect(query).toContain("destinationOrganizationId: $destinationOrganizationId");
    expect(query).toContain("organizationId");
    expect(query).not.toContain("projectId");
    expect(query).toContain("slug");
  });

  it("shows only other owned organizations and previews the canonical path", async () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "Move check" })).toBeInTheDocument();
    await selectDestination();

    expect(screen.queryByRole("option", { name: "Admin Org" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Source Org" })).not.toBeInTheDocument();
    expect(screen.getByText("/destination/nightly-backup")).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Move check" }),
    ).toBeEnabled();
  });

  it("renders nothing without another owned organization", () => {
    orgContext.orgs = [orgs[0], orgs[1]];
    renderDialog();

    expect(screen.queryByRole("button", { name: "Move check" })).not.toBeInTheDocument();
  });

  it.each(["ADMIN", "MEMBER"])(
    "renders nothing when the source organization role is %s",
    (role) => {
      orgContext.orgs = [{ ...orgs[0], role }, orgs[2]];
      renderDialog();

      expect(screen.queryByRole("button", { name: "Move check" })).not.toBeInTheDocument();
    },
  );

  it("submits exact variables, invalidates cached variants, closes, and reports the destination", async () => {
    const { getCapturedVariables, onMoved, refetchQueries, evict, gc } = renderDialog();
    await selectDestination();
    onMoved.mockImplementation(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Move check" }),
    );

    await waitFor(() =>
      expect(getCapturedVariables()).toEqual({
        checkId: "check-1",
        destinationOrganizationId: "org-destination",
      }),
    );
    expect(evict).toHaveBeenCalledWith({ id: "ROOT_QUERY", fieldName: "checks" });
    expect(evict).toHaveBeenCalledWith({ id: "ROOT_QUERY", fieldName: "statusPages" });
    expect(evict).toHaveBeenCalledWith({
      id: "ROOT_QUERY",
      fieldName: "checkByOrganizationSlug",
      args: {
        orgSlug: "source",
        checkSlug: "nightly-backup",
      },
    });
    expect(gc).toHaveBeenCalled();
    expect(refetchQueries).toHaveBeenCalledWith({ include: ["checks", "statusPages"] });
    expect(onMoved).toHaveBeenCalledWith({
      organizationId: "org-destination",
      organizationSlug: "destination",
      checkSlug: "nightly-backup",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps a completed move closed and calls onMoved when refresh rejects", async () => {
    const { onMoved } = renderDialog({ refreshReject: true });
    await selectDestination();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Move check" }),
    );

    await waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a rejected mutation inline and retains the selection", async () => {
    renderDialog({ reject: true });
    await selectDestination();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Move check" }),
    );

    expect(await screen.findByText("Destination already has that slug")).toBeInTheDocument();
    const selects = screen.getAllByRole("combobox");
    expect(selects[0]).toHaveTextContent("Destination Org");
  });

  it("resets selections and errors when reopened", async () => {
    renderDialog({ reject: true });
    await selectDestination();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Move check" }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Move check" }));

    const selects = screen.getAllByRole("combobox");
    expect(selects).toHaveLength(1);
    expect(selects[0]).toHaveTextContent("Select organization");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
