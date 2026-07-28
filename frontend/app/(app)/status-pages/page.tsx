"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "@apollo/client/react";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import {
  STATUS_PAGES,
  CREATE_STATUS_PAGE,
  DELETE_STATUS_PAGE,
  CHECKS,
} from "@/lib/queries";
import { statusPagePublicPath } from "@/lib/status-page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Trash2, Plus, Copy, Check, ExternalLink } from "lucide-react";

interface StatusPage {
  id: string;
  slug: string;
  title: string;
  checkIds: string[];
}

interface CheckItem {
  id: string;
  name: string;
  status: string;
}

interface CopyButtonProps {
  text: string;
}

function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      title="Copy public URL"
      className="h-6 w-6 shrink-0"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

interface StatusPagesManagerProps {
  projectId: string;
}

function StatusPagesManager({ projectId }: StatusPagesManagerProps) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [selectedCheckIds, setSelectedCheckIds] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const { data: pagesData, refetch: refetchPages, loading: pagesLoading, error: pagesError } =
    useQuery<{ statusPages: StatusPage[] }>(STATUS_PAGES, {
      variables: { projectId },
    });

  const { data: checksData, loading: checksLoading, error: checksError } =
    useQuery<{ checks: CheckItem[] }>(CHECKS, {
      variables: { projectId },
    });

  const [createStatusPage, { loading: creating, error: createError }] = useMutation(
    CREATE_STATUS_PAGE,
    {
      onCompleted: () => {
        setSlug("");
        setTitle("");
        setSelectedCheckIds([]);
        refetchPages();
      },
    }
  );

  const [deleteStatusPage, { loading: deleting, error: deleteError }] = useMutation(DELETE_STATUS_PAGE, {
    onCompleted: () => {
      setConfirmDeleteId(null);
      refetchPages();
    },
  });

  useEffect(() => {
    if (pagesError) Promise.resolve().then(() => setErrorMessage(pagesError.message));
  }, [pagesError]);

  useEffect(() => {
    if (checksError) Promise.resolve().then(() => setErrorMessage(checksError.message));
  }, [checksError]);

  useEffect(() => {
    if (createError) Promise.resolve().then(() => setErrorMessage(createError.message));
  }, [createError]);

  useEffect(() => {
    if (deleteError) {
      Promise.resolve().then(() => {
        setConfirmDeleteId(null);
        setErrorMessage(deleteError.message);
      });
    }
  }, [deleteError]);

  function toggleCheck(checkId: string) {
    setSelectedCheckIds((prev) =>
      prev.includes(checkId) ? prev.filter((id) => id !== checkId) : [...prev, checkId]
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    await createStatusPage({
      variables: {
        projectId,
        slug,
        title,
        checkIds: selectedCheckIds,
      },
    });
  }

  const pages = pagesData?.statusPages ?? [];
  const checks = checksData?.checks ?? [];
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_URL ?? "");

  return (
    <div className="space-y-6">
      {pagesLoading && (
        <p className="text-sm text-muted-foreground">Loading status pages…</p>
      )}

      {!pagesLoading && pages.length === 0 && (
        <p className="text-sm text-muted-foreground">No status pages yet.</p>
      )}

      {pages.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y overflow-hidden rounded-xl">
              {pages.map((page) => {
                const publicPath = statusPagePublicPath(page.slug);
                const publicUrl = `${origin}${publicPath}`;
                return (
                  <div key={page.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{page.title}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <code className="font-mono text-xs text-muted-foreground truncate">
                          {publicUrl}
                        </code>
                        <CopyButton text={publicUrl} />
                        <Link
                          href={publicPath}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open status page"
                          className="inline-flex items-center justify-center h-6 w-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {page.checkIds.length} check
                        {page.checkIds.length !== 1 ? "s" : ""}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setConfirmDeleteId(page.id)}
                      title="Delete status page"
                      className="text-destructive hover:text-destructive shrink-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Create status page
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="page-slug">Slug</Label>
                <Input
                  id="page-slug"
                  type="text"
                  placeholder="acme-status"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="page-title">Title</Label>
                <Input
                  id="page-title"
                  type="text"
                  placeholder="Acme Status"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Checks to include</Label>
              {checksLoading && (
                <p className="text-xs text-muted-foreground">Loading checks…</p>
              )}
              {!checksLoading && checks.length === 0 && (
                <p className="text-xs text-muted-foreground">No checks in this project.</p>
              )}
              {checks.length > 0 && (
                <div className="border border-border rounded-lg divide-y max-h-48 overflow-y-auto">
                  {checks.map((check) => (
                    <div key={check.id} className="flex items-center gap-2 px-3 py-2">
                      <Checkbox
                        id={`check-${check.id}`}
                        checked={selectedCheckIds.includes(check.id)}
                        onCheckedChange={() => toggleCheck(check.id)}
                      />
                      <Label
                        htmlFor={`check-${check.id}`}
                        className="cursor-pointer text-sm font-normal"
                      >
                        {check.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Button type="submit" disabled={creating} className="w-full">
              {creating ? "Creating…" : "Create status page"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Confirm delete dialog */}
      <Dialog
        open={!!confirmDeleteId}
        onOpenChange={(open: boolean) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete status page?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This status page will be removed and its public URL will stop working.
            This action cannot be undone.
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                if (confirmDeleteId) {
                  deleteStatusPage({ variables: { id: confirmDeleteId } });
                }
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Error dialog */}
      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function StatusPagesPage() {
  const { user } = useAuth();
  const { activeOrg } = useOrg();

  if (!user) return null;

  const firstProject = activeOrg?.projects[0];

  return (
    <div className="px-4 py-6 sm:px-6 space-y-6">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Status Pages</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Public status pages for your services and checks.
        </p>
      </div>

      {!firstProject ? (
        <p className="text-muted-foreground">No projects found.</p>
      ) : (
        <StatusPagesManager projectId={firstProject.id} />
      )}
    </div>
  );
}
