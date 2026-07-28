"use client";

import { useState, useRef } from "react";
import { useQuery } from "@apollo/client/react";
import Link from "next/link";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import { ADMIN_USERS } from "@/lib/admin-queries";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { AdminUser } from "@/lib/admin-types";

const PAGE_SIZE = 20;

interface AdminUserList {
  items: AdminUser[];
  total: number;
}

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const { data, loading, error } = useQuery<{ adminUsers: AdminUserList }>(ADMIN_USERS, {
    variables: { search: debouncedSearch || undefined, page: page - 1, pageSize: PAGE_SIZE },
    fetchPolicy: "cache-and-network",
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function handleSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1); // reset to first page on a new search — inside the debounce
    }, 300);
  }

  const users = data?.adminUsers?.items ?? [];
  const total = data?.adminUsers?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Users</h1>
      <p className="mt-1 text-sm text-muted-foreground">{total} total users</p>

      <div className="mt-6 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by email…"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-8"
            aria-label="Search users by email"
          />
        </div>
      </div>

      <div className="mt-4">
        {loading && !data && (
          <div className="space-y-2 py-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive py-4">Error loading users: {error.message}</p>
        )}
        {!loading && !error && users.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">No users found.</p>
        )}
        {users.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>All users</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {users.map((user) => (
                  <div key={user.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{user.email}</span>
                        {user.isAdmin && (
                          <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
                            Admin
                          </span>
                        )}
                        {user.suspendedAt && (
                          <span className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
                            Suspended
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Joined {new Date(user.createdAt).toLocaleDateString()} · {user.organizations.length} org{user.organizations.length !== 1 ? "s" : ""}
                      </p>
                    </div>
                    <Link
                      href={`/admin/users/${user.id}`}
                      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
                    >
                      View
                    </Link>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
