"use client";
import { useState } from "react";
import Link from "next/link";
import { useMutation } from "@apollo/client/react";
import { Check, KeyRound, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { SET_PASSWORD } from "@/lib/queries";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GoogleMark } from "@/components/brand/google-mark";

export default function AccountPage() {
  const { user, refetchMe } = useAuth();
  const [setPassword, { loading }] = useMutation(SET_PASSWORD);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const hasPassword = user?.hasPassword ?? false;
  const googleLinked = user?.googleLinked ?? false;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await setPassword({
        variables: {
          newPassword,
          currentPassword: hasPassword ? currentPassword : null,
        },
      });
      setCurrentPassword("");
      setNewPassword("");
      await refetchMe();
      setSuccessMessage(
        hasPassword ? "Your password has been changed." : "Your password is set."
      );
    } catch {
      setErrorMessage(
        hasPassword
          ? "We couldn't change your password. Check your current password and try again."
          : "We couldn't set your password. Please try again."
      );
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground">{user?.email}</p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Security</CardTitle>
          <CardDescription>How you sign in to SystemVitals.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              {googleLinked ? (
                <Check className="h-4 w-4 text-primary" aria-label="Connected" />
              ) : (
                <X className="h-4 w-4 text-muted-foreground" aria-label="Not connected" />
              )}
              <GoogleMark className="h-4 w-4" />
              <span>Google</span>
              <span className="text-muted-foreground">
                {googleLinked ? "connected" : "not connected"}
              </span>
            </li>
            <li className="flex items-center gap-2">
              {hasPassword ? (
                <Check className="h-4 w-4 text-primary" aria-label="Set" />
              ) : (
                <X className="h-4 w-4 text-muted-foreground" aria-label="Not set" />
              )}
              <span>Password</span>
              <span className="text-muted-foreground">
                {hasPassword ? "set" : "not set"}
              </span>
            </li>
          </ul>

          <form onSubmit={handleSubmit} className="space-y-4">
            {hasPassword && (
              <div className="space-y-2">
                <Label htmlFor="currentPassword">Current password</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
            </div>
            <Button type="submit" disabled={loading}>
              {hasPassword ? "Change password" : "Set password"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <KeyRound className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <CardTitle>Agent connections</CardTitle>
              <CardDescription className="mt-1">
                Review connection history and revoke agent credentials.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Link
            href="/account/agent-connections"
            className={buttonVariants({ variant: "outline" })}
          >
            Manage agent connections
          </Link>
        </CardContent>
      </Card>

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Couldn&apos;t save your password</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>

      <Dialog open={!!successMessage} onOpenChange={() => setSuccessMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Password saved</DialogTitle>
            <DialogDescription>{successMessage}</DialogDescription>
          </DialogHeader>
          <Button onClick={() => setSuccessMessage(null)}>Done</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
