"use client";
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyField({ value, label = "value" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono truncate" title={value}>
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleCopy}
        title={copied ? "Copied" : `Copy ${label}`}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}
