import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Verify email notification",
  robots: { index: false, follow: false },
};

export default function VerifyEmailLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
