import { MockedProvider } from "@apollo/client/testing/react";
import type { MockedResponse } from "@apollo/client/testing";
import { InMemoryCache } from "@apollo/client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMAIL_CHANNEL_VERIFICATION_PREVIEW,
  VERIFY_EMAIL_CHANNEL,
} from "@/lib/queries";
import VerifyEmailPage from "./page";

let search = "token=verification-secret";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

type PreviewFixture = {
  status: "PENDING" | "EXPIRED" | "INVALID";
  maskedEmail: string | null;
  organizationName: string | null;
  projectName: string | null;
  expiresAt: string | null;
};

const pendingPreview: PreviewFixture = {
  status: "PENDING",
  maskedEmail: "a•••••@example.com",
  organizationName: "Acme",
  projectName: "Default",
  expiresAt: "2026-07-28T12:00:00.000Z",
};

function previewMock(
  preview: PreviewFixture = pendingPreview,
  result: MockedResponse["result"] = vi.fn(() => ({
    data: { emailChannelVerificationPreview: preview },
  })),
): MockedResponse {
  return {
    request: {
      query: EMAIL_CHANNEL_VERIFICATION_PREVIEW,
      variables: { token: "verification-secret" },
    },
    result,
  };
}

function verificationMock(
  result: MockedResponse["result"] = vi.fn(() => ({
    data: {
      verifyEmailChannel: {
        status: "VERIFIED",
        maskedEmail: "a•••••@example.com",
        organizationName: "Acme",
        projectName: "Default",
      },
    },
  })),
): MockedResponse {
  return {
    request: {
      query: VERIFY_EMAIL_CHANNEL,
      variables: { token: "verification-secret" },
    },
    result,
  };
}

function renderPage(
  mocks: MockedResponse[] = [],
  cache = new InMemoryCache(),
) {
  return render(
    <MockedProvider mocks={mocks} cache={cache}>
      <VerifyEmailPage />
    </MockedProvider>,
  );
}

describe("/verify-email", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    search = "token=verification-secret";
    history.replaceState(null, "", "/verify-email?token=verification-secret");
  });

  it("previews on initial render without invoking verification", async () => {
    const preview = vi.fn(() => ({
      data: { emailChannelVerificationPreview: pendingPreview },
    }));
    const verify = vi.fn(() => ({
      data: {
        verifyEmailChannel: {
          status: "VERIFIED",
          maskedEmail: pendingPreview.maskedEmail,
          organizationName: pendingPreview.organizationName,
          projectName: pendingPreview.projectName,
        },
      },
    }));

    renderPage([previewMock(pendingPreview, preview), verificationMock(verify)]);

    expect(
      await screen.findByRole("heading", { name: "Review email verification" }),
    ).toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it("shows the masked recipient, organization, and dominant verification action", async () => {
    renderPage([previewMock()]);

    expect(await screen.findByText("a•••••@example.com")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Verify email" }),
    ).toBeEnabled();
  });

  it("verifies exactly once and guards repeated clicks while loading", async () => {
    const verify = vi.fn(() => ({
      data: {
        verifyEmailChannel: {
          status: "VERIFIED",
          maskedEmail: pendingPreview.maskedEmail,
          organizationName: pendingPreview.organizationName,
          projectName: pendingPreview.projectName,
        },
      },
    }));
    renderPage([
      previewMock(),
      {
        ...verificationMock(verify),
        delay: 100,
      },
    ]);

    const button = await screen.findByRole("button", { name: "Verify email" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Verifying…");
  });

  it("cleans the bearer token from history and renders the exact success state", async () => {
    const replaceState = vi.spyOn(history, "replaceState");
    renderPage([previewMock(), verificationMock()]);

    fireEvent.click(
      await screen.findByRole("button", { name: "Verify email" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Email verified — alerts are now active",
      }),
    ).toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/verify-email");
    expect(screen.getByText("a•••••@example.com")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /log in/i }),
    ).toHaveAttribute("href", "/login");
  });

  it("never retains the raw bearer token in Apollo cache after preview or verification", async () => {
    const cache = new InMemoryCache();
    renderPage([previewMock(), verificationMock()], cache);

    const verifyButton = await screen.findByRole("button", {
      name: "Verify email",
    });
    expect(JSON.stringify(cache.extract())).not.toContain(
      "verification-secret",
    );

    fireEvent.click(verifyButton);
    await screen.findByRole("heading", {
      name: "Email verified — alerts are now active",
    });

    expect(JSON.stringify(cache.extract())).not.toContain(
      "verification-secret",
    );
  });

  it("keeps server-confirmed success when URL cleanup throws and does not verify again", async () => {
    const verify = vi.fn(() => ({
      data: {
        verifyEmailChannel: {
          status: "VERIFIED",
          maskedEmail: pendingPreview.maskedEmail,
          organizationName: pendingPreview.organizationName,
          projectName: pendingPreview.projectName,
        },
      },
    }));
    vi.spyOn(history, "replaceState").mockImplementation(() => {
      throw new Error("History API unavailable");
    });
    renderPage([previewMock(), verificationMock(verify)]);

    fireEvent.click(
      await screen.findByRole("button", { name: "Verify email" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Email verified — alerts are now active",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("We couldn't verify this email. Please try again."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify email" })).toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("announces the successful state transition to assistive technology", async () => {
    renderPage([previewMock(), verificationMock()]);

    fireEvent.click(
      await screen.findByRole("button", { name: "Verify email" }),
    );

    const status = await screen.findByRole("status", {
      name: "Email verified — alerts are now active",
    });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toContainElement(
      screen.getByRole("heading", {
        name: "Email verified — alerts are now active",
      }),
    );
  });

  it.each([
    ["EXPIRED", "This verification link has expired"],
    ["INVALID", "This verification link is invalid or has already been used"],
  ] as const)("renders a safe %s state", async (status, heading) => {
    renderPage([
      previewMock({
        status,
        maskedEmail: null,
        organizationName: null,
        projectName: null,
        expiresAt: null,
      }),
    ]);

    expect(
      await screen.findByRole("heading", { name: heading }),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("alerts@example.com");
    expect(screen.queryByRole("button", { name: "Verify email" })).toBeNull();
    expect(
      screen.getByRole("link", { name: /log in/i }),
    ).toHaveAttribute("href", "/login");
  });

  it("makes no GraphQL request when the token is missing", async () => {
    search = "";
    const preview = vi.fn();
    const verify = vi.fn();

    renderPage([previewMock(pendingPreview, preview), verificationMock(verify)]);

    expect(
      await screen.findByRole("heading", {
        name: "This verification link is invalid or has already been used",
      }),
    ).toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("handles preview network failures accessibly in-page", async () => {
    renderPage([
      {
        request: {
          query: EMAIL_CHANNEL_VERIFICATION_PREVIEW,
          variables: { token: "verification-secret" },
        },
        error: new Error("Network unavailable"),
      },
    ]);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't check this verification link. Please try again.",
    );
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("handles verification failures accessibly and allows another deliberate attempt", async () => {
    renderPage([
      previewMock(),
      {
        request: {
          query: VERIFY_EMAIL_CHANNEL,
          variables: { token: "verification-secret" },
        },
        error: new Error("Network unavailable"),
      },
    ]);

    fireEvent.click(
      await screen.findByRole("button", { name: "Verify email" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't verify this email. Please try again.",
    );
    expect(
      screen.getByRole("button", { name: "Verify email" }),
    ).toBeEnabled();
  });

  it("does not use authenticated app navigation or automatic redirects", async () => {
    renderPage([previewMock()]);

    await screen.findByRole("heading", { name: "Review email verification" });
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByText(/dashboard/i)).toBeNull();
    expect(
      screen.getByRole("link", { name: /log in/i }),
    ).toHaveAttribute("href", "/login");
  });

  it("uses legacy projectName only as a rolling-deployment fallback", async () => {
    renderPage([
      previewMock({
        ...pendingPreview,
        organizationName: null,
        projectName: "Legacy workspace",
      }),
    ]);

    expect(await screen.findByText("Legacy workspace")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
  });

  it("never renders or persists the raw token", async () => {
    renderPage([previewMock()]);

    await screen.findByRole("heading", { name: "Review email verification" });
    expect(document.body).not.toHaveTextContent("verification-secret");
    expect(localStorage.getItem("verification-secret")).toBeNull();
    expect(sessionStorage.getItem("verification-secret")).toBeNull();
  });
});
