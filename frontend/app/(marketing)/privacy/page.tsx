import type { Metadata } from "next";
import {
  LegalDocument,
  type LegalSection,
} from "@/components/marketing/legal-document";
import { SITE } from "@/lib/site";

const EFFECTIVE_DATE = "July 25, 2026";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${SITE.name} collects, uses, and protects personal data.`,
  alternates: { canonical: "/privacy" },
  openGraph: {
    type: "website",
    siteName: SITE.name,
    locale: "en_US",
    url: "/privacy",
    title: `Privacy Policy · ${SITE.name}`,
    description: `How ${SITE.name} collects, uses, and protects personal data.`,
  },
  robots: { index: true, follow: true },
};

const sections: LegalSection[] = [
  {
    id: "scope",
    title: "Scope and controller",
    content: (
      <>
        <p>
          This Privacy Policy explains how SystemVitals collects, uses, shares,
          and protects personal data when you use our websites, applications,
          APIs, MCP integrations, monitoring infrastructure, and related
          services (the <strong>“Service”</strong>).
        </p>
        <p>
          SystemVitals is the controller of account and product-usage data. An
          organization may be the controller of data it submits to the Service,
          with SystemVitals acting as its processor or service provider.
        </p>
      </>
    ),
  },
  {
    id: "data-collected",
    title: "Data we collect",
    content: (
      <>
        <ul>
          <li>
            <strong>Account data:</strong> email address, encrypted password
            credentials, Google account identifiers when used, organization
            memberships, roles, and preferences.
          </li>
          <li>
            <strong>Monitoring data:</strong> check names, target URLs,
            hostnames, IP addresses, heartbeat events, response metadata,
            incidents, status-page content, and alert configuration.
          </li>
          <li>
            <strong>Integration data:</strong> notification destinations,
            webhook configuration, API-token metadata and permissions. Secret
            token values are shown only when created and are stored as hashes.
          </li>
          <li>
            <strong>Telegram connection data:</strong> Telegram destination
            identifiers, titles, and topic identifiers, connection commands,
            and notification delivery results. We process connection commands
            used to set up a destination, not ordinary group messages. Alert
            content is shared with Telegram for delivery.
          </li>
          <li>
            <strong>Billing data:</strong> plan, subscription status, billing
            identifiers, and transaction metadata. Stripe receives and
            processes full payment-card details; SystemVitals does not store
            them.
          </li>
          <li>
            <strong>Technical data:</strong> IP address, user agent, request
            logs, timestamps, error reports, security events, and approximate
            location inferred from IP where available.
          </li>
          <li>
            <strong>Communications:</strong> messages and support requests you
            send to us.
          </li>
        </ul>
        <p>
          Monitoring targets and payloads may contain personal data depending
          on how you configure them. Do not submit sensitive data that is not
          necessary for monitoring.
        </p>
      </>
    ),
  },
  {
    id: "use",
    title: "How we use data",
    content: (
      <>
        <p>We process data to:</p>
        <ul>
          <li>provide checks, incident history, alerts, status pages, APIs, and MCP access;</li>
          <li>authenticate users and administer organizations, roles, plans, and billing;</li>
          <li>secure the Service, prevent abuse, investigate incidents, and enforce our terms;</li>
          <li>support users and communicate service, security, and policy updates;</li>
          <li>measure reliability and improve features using aggregated or de-identified data; and</li>
          <li>meet tax, accounting, legal, and regulatory obligations.</li>
        </ul>
        <p>
          We do not sell personal data or use monitoring data for third-party
          behavioral advertising.
        </p>
      </>
    ),
  },
  {
    id: "legal-bases",
    title: "Legal bases",
    content: (
      <p>
        Where a legal basis is required, we rely on performance of our contract
        to provide the Service; legitimate interests in operating, securing,
        and improving it; compliance with legal obligations; and consent where
        specifically requested. You may withdraw consent at any time without
        affecting earlier processing.
      </p>
    ),
  },
  {
    id: "sharing",
    title: "How data is shared",
    content: (
      <>
        <p>We share data only as needed with:</p>
        <ul>
          <li>
            infrastructure, database, email, observability, and security
            providers that operate the Service for us;
          </li>
          <li>Stripe for payment and subscription management;</li>
          <li>Google when you choose Google sign-in;</li>
          <li>
            email, Slack, Telegram, and webhook providers you configure to
            receive alerts;
          </li>
          <li>members of organizations according to their roles and permissions;</li>
          <li>
            professional advisers, authorities, or other parties when required
            by law or necessary to protect rights and safety; and
          </li>
          <li>
            a successor in a merger, financing, acquisition, or sale, subject
            to appropriate confidentiality protections.
          </li>
        </ul>
        <p>
          Public status pages intentionally disclose the names, status, and
          incident information that an authorized user chooses to publish.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "Retention",
    content: (
      <>
        <p>
          We retain account and configuration data while your account is active
          and as needed to provide the Service. Monitoring events and operational
          logs are retained according to plan limits, security needs, and
          reasonable backup cycles.
        </p>
        <p>
          After deletion, data may remain temporarily in backups and may be
          retained longer where required for fraud prevention, dispute
          resolution, accounting, or law. We delete or de-identify it when the
          applicable purpose and retention period end.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "Security",
    content: (
      <>
        <p>
          We use administrative, technical, and organizational safeguards
          designed to protect data, including access controls, encryption in
          transit, credential hashing, secret minimization, logging, and
          infrastructure isolation.
        </p>
        <p>
          No system is completely secure. You are responsible for securing your
          account, limiting token permissions, revoking unused tokens, and
          protecting notification destinations and monitored systems.
        </p>
      </>
    ),
  },
  {
    id: "transfers",
    title: "International transfers",
    content: (
      <p>
        Our providers may process data in countries other than yours. Where
        required, we use recognized safeguards for international transfers,
        such as contractual protections, adequacy decisions, or another lawful
        transfer mechanism.
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your privacy rights",
    content: (
      <>
        <p>
          Depending on your location, including under Brazil’s LGPD or the
          European GDPR, you may have rights to confirm processing; access,
          correct, export, delete, or anonymize data; restrict or object to
          processing; withdraw consent; and receive information about sharing.
        </p>
        <p>
          Send requests to{" "}
          <a href="mailto:support@systemvitals.link">
            support@systemvitals.link
          </a>
          . We may verify your identity and authority before acting. You may
          also complain to your local data-protection authority. If your
          organization controls the data, contact its owner first; we will
          assist the organization as required.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and local storage",
    content: (
      <p>
        We use storage necessary to authenticate you, maintain security, and
        remember essential preferences. The web application stores the session
        token in your browser’s local storage. We do not use third-party
        advertising cookies. Browser settings may clear stored data, but
        disabling required storage can prevent sign-in.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    content: (
      <p>
        The Service is intended for people who can legally enter a contract and
        is not directed to children under 13. If local law requires a higher
        minimum age for independent consent, that age applies. Contact us if
        you believe a child provided personal data improperly.
      </p>
    ),
  },
  {
    id: "changes-contact",
    title: "Changes and contact",
    content: (
      <>
        <p>
          We may update this policy as the Service or law changes. We will post
          the revised version, update the effective date, and provide reasonable
          notice of material changes.
        </p>
        <p>
          Questions, complaints, and data requests can be sent to{" "}
          <a href="mailto:support@systemvitals.link">
            support@systemvitals.link
          </a>
          .
        </p>
      </>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalDocument
      eyebrow="Legal / Privacy"
      title="Privacy Policy"
      summary="What SystemVitals collects, why we need it, and the controls you have over your data."
      effectiveDate={EFFECTIVE_DATE}
      sections={sections}
    />
  );
}
