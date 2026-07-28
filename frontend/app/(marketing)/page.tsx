import { Hero } from "@/components/marketing/hero";
import { CapabilityBar } from "@/components/marketing/capability-bar";
import { FeatureGrid } from "@/components/marketing/feature-grid";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { NotificationRouting } from "@/components/marketing/notification-routing";
import { StatusShowcase } from "@/components/marketing/status-showcase";
import { Mcp } from "@/components/marketing/mcp";
import { Pricing } from "@/components/marketing/pricing";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <CapabilityBar />
      <FeatureGrid />
      <HowItWorks />
      <NotificationRouting />
      <StatusShowcase />
      <Mcp />
      <Pricing />
    </>
  );
}
