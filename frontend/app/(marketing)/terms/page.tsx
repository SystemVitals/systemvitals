import type { Metadata } from "next";
import Link from "next/link";
import {
  LegalDocument,
  type LegalSection,
} from "@/components/marketing/legal-document";
import { SITE } from "@/lib/site";

const EFFECTIVE_DATE = "July 25, 2026";

export const metadata: Metadata = {
  title: "Terms and Conditions",
  description: `Terms and Conditions governing use of ${SITE.name}.`,
  alternates: { canonical: "/terms" },
  openGraph: {
    type: "website",
    siteName: SITE.name,
    locale: "en_US",
    url: "/terms",
    title: `Terms and Conditions · ${SITE.name}`,
    description: `Terms and Conditions governing use of ${SITE.name}.`,
  },
  robots: { index: true, follow: true },
};

const sections: LegalSection[] = [
  {
    id: "agreement",
    title: "Agreement to these terms",
    content: (
      <>
        <p>
          These Terms and Conditions form a binding agreement between you and
          SystemVitals for your use of our websites, applications, APIs, MCP
          integrations, monitoring infrastructure, and related services
          (collectively, the <strong>“Service”</strong>).
        </p>
        <p>
          By creating an account, using the Service, or accepting an invitation
          to an organization, you agree to these terms and our{" "}
          <Link href="/privacy">Privacy Policy</Link>. If you use the Service
          for an organization, you confirm that you are authorized to accept
          these terms for it.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts and organizations",
    content: (
      <>
        <p>
          You must provide accurate account information, be legally capable of
          entering this agreement, and keep your credentials secure. You are
          responsible for activity performed through your account, API tokens,
          MCP clients, and organization memberships.
        </p>
        <p>
          Organization owners control membership, roles, billing, and ownership
          transfers. A transfer may be blocked when the receiving account does
          not meet applicable plan or account requirements. Removing a member
          does not automatically revoke credentials that the member copied
          outside the Service; owners should rotate affected secrets.
        </p>
        <p>
          Tell us promptly at{" "}
          <a href="mailto:support@systemvitals.link">
            support@systemvitals.link
          </a>{" "}
          if you suspect unauthorized access.
        </p>
      </>
    ),
  },
  {
    id: "service",
    title: "Monitoring service",
    content: (
      <>
        <p>
          SystemVitals performs heartbeat, HTTP, TCP, and ping monitoring,
          records results, and may send alerts through channels you configure.
          Monitoring is an operational aid—not an emergency service, security
          control, backup system, or guarantee that a failure will be detected.
        </p>
        <p>
          You are responsible for configuring checks, recipients, escalation
          rules, and status pages correctly; testing alert delivery; and
          maintaining independent safeguards appropriate to your systems.
          Public status pages and webhook destinations are published or
          contacted according to your configuration.
        </p>
      </>
    ),
  },
  {
    id: "automation",
    title: "API, agents, and MCP",
    content: (
      <>
        <p>
          You may authorize software agents, scripts, and MCP clients to manage
          the Service using API tokens. Tokens act with the permissions assigned
          to them. You are responsible for the actions of clients that receive
          your tokens and for reviewing their permissions before use.
        </p>
        <p>
          Store tokens as secrets, transmit them only over secure connections,
          and revoke them when they are no longer needed or may be compromised.
          Tokens may have no expiration unless you choose one, but can be
          revoked at any time.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    content: (
      <>
        <p>You may only monitor systems you own or are authorized to test. You must not:</p>
        <ul>
          <li>probe, scan, or access systems without authorization;</li>
          <li>evade rate limits, plan limits, security controls, or access restrictions;</li>
          <li>use the Service to distribute malware, spam, or unlawful content;</li>
          <li>interfere with the Service or impose an unreasonable load on it;</li>
          <li>reverse engineer the Service except where applicable law permits it; or</li>
          <li>use monitoring data to violate privacy, employment, or other laws.</li>
        </ul>
        <p>
          We may rate-limit or suspend activity that threatens the Service or
          third parties. When practical, we will provide notice and an
          opportunity to correct the issue.
        </p>
      </>
    ),
  },
  {
    id: "plans-billing",
    title: "Plans and billing",
    content: (
      <>
        <p>
          Plan limits and prices are shown before purchase. Paid subscriptions
          renew automatically for the selected billing period until canceled.
          Taxes may apply. Payments and billing details are processed by Stripe
          under its own terms and privacy policy.
        </p>
        <p>
          You may cancel through the billing portal. Cancellation takes effect
          at the end of the paid period unless stated otherwise. Except where
          required by law, fees already paid are non-refundable. We will give
          reasonable advance notice of material price changes.
        </p>
      </>
    ),
  },
  {
    id: "data-content",
    title: "Your data and our materials",
    content: (
      <>
        <p>
          You retain ownership of data and configuration you submit. You grant
          us a limited license to host, process, transmit, and display that data
          only as needed to operate, secure, and improve the Service and comply
          with law.
        </p>
        <p>
          SystemVitals and its licensors retain all rights in the Service,
          software, branding, documentation, and aggregated or de-identified
          insights. No rights are granted except those expressly stated here.
          Feedback may be used without restriction or compensation.
        </p>
      </>
    ),
  },
  {
    id: "availability",
    title: "Availability and changes",
    content: (
      <>
        <p>
          We work to keep the Service reliable, but unless a separate written
          service-level agreement applies, the Service is provided without an
          uptime guarantee. Maintenance, upstream provider failures, internet
          conditions, and events outside our control may interrupt it.
        </p>
        <p>
          We may add, change, or discontinue features. If a change materially
          reduces a paid Service, we will provide reasonable notice where
          practicable.
        </p>
      </>
    ),
  },
  {
    id: "termination",
    title: "Suspension and termination",
    content: (
      <>
        <p>
          You may stop using the Service at any time. Account deletion and data
          retention are described in the Privacy Policy. We may suspend or
          terminate access for material breach, non-payment, security risk,
          unlawful conduct, or harm to the Service or others.
        </p>
        <p>
          Where appropriate, we will provide notice and a chance to cure.
          Provisions that by their nature should survive termination—including
          ownership, disclaimers, liability limits, and dispute terms—will survive.
        </p>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    content: (
      <p>
        To the maximum extent permitted by law, the Service is provided
        <strong> “as is” and “as available.”</strong> We disclaim implied
        warranties of merchantability, fitness for a particular purpose,
        non-infringement, and uninterrupted or error-free operation. We do not
        warrant that every outage, delayed heartbeat, security issue, or
        delivery failure will be detected or reported.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    content: (
      <>
        <p>
          To the maximum extent permitted by law, SystemVitals will not be
          liable for indirect, incidental, special, consequential, exemplary,
          or punitive damages, or for lost profits, revenue, data, goodwill, or
          business interruption arising from the Service.
        </p>
        <p>
          Our total liability for claims arising in the twelve months before the
          event giving rise to liability will not exceed the greater of
          US&nbsp;$100 or the amount you paid us during that period. These limits
          do not apply where prohibited by law.
        </p>
      </>
    ),
  },
  {
    id: "law-changes",
    title: "Governing law and updates",
    content: (
      <>
        <p>
          These terms are governed by the laws of Brazil, without regard to
          conflict-of-law rules. Courts with jurisdiction under applicable
          consumer and procedural law may hear disputes. Mandatory consumer
          rights in your place of residence remain unaffected.
        </p>
        <p>
          We may update these terms. We will post the revised version and change
          the effective date; for material changes, we will provide reasonable
          notice. Continued use after the change takes effect constitutes
          acceptance where permitted by law.
        </p>
      </>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalDocument
      eyebrow="Legal / Terms"
      title="Terms and Conditions"
      summary="The rules that keep SystemVitals useful, secure, and fair for everyone monitoring their systems."
      effectiveDate={EFFECTIVE_DATE}
      sections={sections}
    />
  );
}
