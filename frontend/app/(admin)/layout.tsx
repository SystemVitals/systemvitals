"use client";
import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { ApolloProvider } from "@apollo/client/react";
import { useAuth } from "@/lib/auth-context";
import { makeAdminApolloClient } from "@/lib/admin-apollo";
import { AdminSidebar } from "@/components/admin/admin-sidebar";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const client = useMemo(() => makeAdminApolloClient(), []);
  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
    else if (!user.isAdmin) router.push("/dashboard");
  }, [user, loading, router]);
  if (loading) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  if (!user || !user.isAdmin) return null;
  return (
    <ApolloProvider client={client}>
      <div className="flex min-h-screen">
        <AdminSidebar />
        <main className="flex-1 lg:ml-56 mx-auto max-w-6xl p-4 sm:p-8">{children}</main>
      </div>
    </ApolloProvider>
  );
}
