import { Activity, Bell, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SITE } from "@/lib/site";

const GROUPS = [
  { label: "Monitors", items: SITE.capabilities.monitors, Icon: Activity },
  { label: "Channels", items: SITE.capabilities.channels, Icon: Bell },
  { label: "Platform", items: SITE.capabilities.platform, Icon: Layers },
] as const;

export function CapabilityBar() {
  return (
    <div className="border-t border-b border-border bg-muted/40">
      <div className="mx-auto flex max-w-5xl flex-wrap items-start justify-between gap-6 px-4 py-6 sm:flex-nowrap">
        {GROUPS.map(({ label, items, Icon }) => (
          <div key={label} className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              {label}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {items.map((item) => (
                <Badge key={item} variant="outline">
                  {item}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
