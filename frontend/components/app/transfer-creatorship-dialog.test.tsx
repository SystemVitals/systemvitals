import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import type { MockedResponse } from "@apollo/client/testing";
import { TransferCreatorshipDialog } from "./transfer-creatorship-dialog";
import {
  ORGANIZATION_MEMBERS,
  TRANSFER_ORGANIZATION_CREATORSHIP,
} from "@/lib/queries";
import type { Org } from "@/lib/auth-context";

const organization: Org = {
  id: "org-exact",
  name: "Acme",
  slug: "acme",
  role: "OWNER",
  plan: "SIGNAL",
  creatorUserId: "creator-exact",
  creatorLabel: "creator@example.com",
  projects: [],
};

const owners = [
  { id: "membership-creator", userId: "creator-exact", email: "creator@example.com", role: "OWNER", createdAt: "2026-01-01" },
  { id: "membership-owner", userId: "owner-exact", email: "owner@example.com", role: "OWNER", createdAt: "2026-01-01" },
  { id: "membership-admin", userId: "admin-exact", email: "admin@example.com", role: "ADMIN", createdAt: "2026-01-01" },
  { id: "membership-member", userId: "member-exact", email: "member@example.com", role: "MEMBER", createdAt: "2026-01-01" },
];

function membersMock(result = vi.fn(() => ({
  data: { organizationMembers: owners },
}))) {
  return {
    request: {
      query: ORGANIZATION_MEMBERS,
      variables: { organizationId: "org-exact" },
    },
    result,
  };
}

function renderDialog({
  currentUserId = "creator-exact",
  mocks = [],
  onTransferred = vi.fn().mockResolvedValue(undefined),
}: {
  currentUserId?: string;
  mocks?: MockedResponse[];
  onTransferred?: () => Promise<unknown>;
} = {}) {
  render(
    <MockedProvider mocks={[membersMock(), ...mocks]}>
      <TransferCreatorshipDialog
        organization={organization}
        currentUserId={currentUserId}
        onTransferred={onTransferred}
      />
    </MockedProvider>,
  );
  return { onTransferred };
}

async function openAndSelectOwner() {
  fireEvent.click(
    screen.getByRole("button", { name: /transfer creatorship for acme/i }),
  );
  fireEvent.click(await screen.findByRole("combobox", { name: /new creator/i }));
  fireEvent.click(await screen.findByRole("option", { name: "owner@example.com" }));
}

describe("TransferCreatorshipDialog", () => {
  it("renders its action only for the actual current creator", () => {
    const { rerender } = render(
      <MockedProvider>
        <TransferCreatorshipDialog
          organization={organization}
          currentUserId="someone-else"
          onTransferred={vi.fn()}
        />
      </MockedProvider>,
    );
    expect(
      screen.queryByRole("button", { name: /transfer creatorship/i }),
    ).not.toBeInTheDocument();

    rerender(
      <MockedProvider>
        <TransferCreatorshipDialog
          organization={organization}
          currentUserId="creator-exact"
          onTransferred={vi.fn()}
        />
      </MockedProvider>,
    );
    expect(
      screen.getByRole("button", { name: /transfer creatorship for acme/i }),
    ).toBeInTheDocument();
  });

  it("offers only other owners and keeps confirmation disabled until selection", async () => {
    renderDialog();
    fireEvent.click(
      screen.getByRole("button", { name: /transfer creatorship for acme/i }),
    );

    expect(
      screen.getByRole("button", { name: /^confirm transfer$/i }),
    ).toBeDisabled();

    fireEvent.click(await screen.findByRole("combobox", { name: /new creator/i }));
    expect(
      await screen.findByRole("option", { name: "owner@example.com" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("creator@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("admin@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("member@example.com")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "owner@example.com" }));
    expect(
      screen.getByRole("button", { name: /^confirm transfer$/i }),
    ).toBeEnabled();
  });

  it("loads members only after opening and scopes the query to the exact org", async () => {
    const memberQuery = vi.fn(() => ({
      data: { organizationMembers: owners },
    }));
    render(
      <MockedProvider mocks={[membersMock(memberQuery)]}>
        <TransferCreatorshipDialog
          organization={organization}
          currentUserId="creator-exact"
          onTransferred={vi.fn()}
        />
      </MockedProvider>,
    );

    expect(memberQuery).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /transfer creatorship for acme/i }),
    );
    await waitFor(() =>
      expect(memberQuery).toHaveBeenCalledExactlyOnceWith({
        organizationId: "org-exact",
      }),
    );

    const selector = await screen.findByRole("combobox", {
      name: /new creator/i,
    });
    expect(selector).toBeInTheDocument();
    fireEvent.click(selector);
    expect(
      await screen.findByRole("option", { name: "owner@example.com" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "creator@example.com" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "admin@example.com" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "member@example.com" }),
    ).not.toBeInTheDocument();
  });

  it("shows a recoverable member-loading error", async () => {
    render(
      <MockedProvider
        mocks={[{
          request: {
            query: ORGANIZATION_MEMBERS,
            variables: { organizationId: "org-exact" },
          },
          error: new Error("Could not load owners."),
        }]}
      >
        <TransferCreatorshipDialog
          organization={organization}
          currentUserId="creator-exact"
          onTransferred={vi.fn()}
        />
      </MockedProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /transfer creatorship for acme/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load owners.",
    );
    expect(
      screen.getByRole("button", { name: /retry loading owners/i }),
    ).toBeInTheDocument();
  });

  it("explicitly confirms that the previous creator remains an owner", async () => {
    renderDialog();
    fireEvent.click(
      screen.getByRole("button", { name: /transfer creatorship for acme/i }),
    );
    expect(
      await screen.findByText(/you will remain an owner/i),
    ).toBeInTheDocument();
  });

  it("sends exact IDs and awaits the refresh before closing", async () => {
    let releaseRefresh: (() => void) | undefined;
    const onTransferred = vi.fn(
      () => new Promise<void>((resolve) => { releaseRefresh = resolve; }),
    );
    const mutation = vi.fn(() => ({
      data: {
        transferOrganizationCreatorship: {
          id: "org-exact",
          creatorUserId: "owner-exact",
          creatorLabel: "owner@example.com",
          plan: "SIGNAL",
        },
      },
    }));
    renderDialog({
      onTransferred,
      mocks: [{
        request: {
          query: TRANSFER_ORGANIZATION_CREATORSHIP,
          variables: {
            organizationId: "org-exact",
            newCreatorUserId: "owner-exact",
          },
        },
        result: mutation,
      }],
    });

    await openAndSelectOwner();
    fireEvent.click(screen.getByRole("button", { name: /^confirm transfer$/i }));

    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onTransferred).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("heading", { name: /transfer creatorship/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/creatorship was transferred successfully/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^confirm transfer$/i }),
    ).not.toBeInTheDocument();

    releaseRefresh?.();
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /transfer creatorship/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps state recoverable and shows an error after server rejection", async () => {
    renderDialog({
      mocks: [{
        request: {
          query: TRANSFER_ORGANIZATION_CREATORSHIP,
          variables: {
            organizationId: "org-exact",
            newCreatorUserId: "owner-exact",
          },
        },
        error: new Error("Only the current creator can transfer creatorship."),
      }],
    });

    await openAndSelectOwner();
    fireEvent.click(screen.getByRole("button", { name: /^confirm transfer$/i }));

    expect(
      await screen.findByText(/only the current creator can transfer/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /transfer creatorship/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /new creator/i })).toHaveTextContent(
      "owner@example.com",
    );
    expect(
      screen.getByRole("button", { name: /^confirm transfer$/i }),
    ).toBeEnabled();
  });

  it("never resubmits after transfer succeeds when refresh fails, and retry only refreshes", async () => {
    const mutation = vi.fn(() => ({
      data: {
        transferOrganizationCreatorship: {
          id: "org-exact",
          creatorUserId: "owner-exact",
          creatorLabel: "owner@example.com",
          plan: "SIGNAL",
        },
      },
    }));
    const onTransferred = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not refresh organizations."))
      .mockResolvedValueOnce(undefined);
    renderDialog({
      onTransferred,
      mocks: [{
        request: {
          query: TRANSFER_ORGANIZATION_CREATORSHIP,
          variables: {
            organizationId: "org-exact",
            newCreatorUserId: "owner-exact",
          },
        },
        result: mutation,
      }],
    });

    await openAndSelectOwner();
    fireEvent.click(screen.getByRole("button", { name: /^confirm transfer$/i }));

    expect(
      await screen.findByText(/creatorship was transferred successfully/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /transfer completed, but organizations could not be refreshed/i,
    );
    expect(
      screen.queryByRole("button", { name: /^confirm transfer$/i }),
    ).not.toBeInTheDocument();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(onTransferred).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /retry refresh/i }));
    await waitFor(() => expect(onTransferred).toHaveBeenCalledTimes(2));
    expect(mutation).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /transfer creatorship/i }),
      ).not.toBeInTheDocument(),
    );
  });
});
