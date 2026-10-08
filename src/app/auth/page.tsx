"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Wrench, Shield, CheckCircle2, Loader2 } from "lucide-react";

function AuthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") || "/";

  const [tab, setTab] = React.useState<string>("login");
  const [role, setRole] = React.useState<"customer" | "mechanic">("customer");

  // Login form state
  const [loginEmail, setLoginEmail] = React.useState("");
  const [loginPassword, setLoginPassword] = React.useState("");
  const [loginError, setLoginError] = React.useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = React.useState(false);

  // Register form state
  const [registerEmail, setRegisterEmail] = React.useState("");
  const [registerPassword, setRegisterPassword] = React.useState("");
  const [registerName, setRegisterName] = React.useState("");
  const [registerPhone, setRegisterPhone] = React.useState("");
  const [inviteCode, setInviteCode] = React.useState("");
  const [registerError, setRegisterError] = React.useState<string | null>(null);
  const [registerSuccess, setRegisterSuccess] = React.useState<string | null>(null);
  const [isRegistering, setIsRegistering] = React.useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setIsLoggingIn(true);

    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginEmail.trim(),
        password: loginPassword,
      });

      if (error || !data.user) {
        setLoginError("Invalid email or password. Please verify your credentials.");
        setIsLoggingIn(false);
        return;
      }

      const userRole = data.user.app_metadata?.role || "customer";
      if (redirectTo && redirectTo !== "/" && redirectTo !== "/auth") {
        router.push(redirectTo);
      } else if (userRole === "mechanic") {
        router.push("/mechanic/queue");
      } else {
        router.push("/dashboard");
      }
      router.refresh();
    } catch (err) {
      console.error("Login unexpected error:", err);
      setLoginError("An unexpected error occurred. Please try again.");
      setIsLoggingIn(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setRegisterError(null);
    setRegisterSuccess(null);
    setIsRegistering(true);

    try {
      const payload: Record<string, unknown> = {
        email: registerEmail.trim(),
        password: registerPassword,
        name: registerName.trim(),
        phone: registerPhone.trim() || undefined,
        role,
      };

      if (role === "mechanic") {
        payload.inviteCode = inviteCode.trim();
      }

      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setRegisterError(data.error || "Registration could not be completed.");
        setIsRegistering(false);
        return;
      }

      setRegisterSuccess(
        role === "mechanic"
          ? "Mechanic account created. You can now sign in."
          : "Account created successfully. You can now sign in."
      );
      setIsRegistering(false);

      // Auto sign in
      const supabase = createClient();
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email: registerEmail.trim(),
        password: registerPassword,
      });

      if (!signInError && signInData.user) {
        if (role === "mechanic") {
          router.push("/mechanic/queue");
        } else {
          router.push("/dashboard");
        }
        router.refresh();
      } else {
        setTab("login");
        setLoginEmail(registerEmail);
      }
    } catch (err) {
      console.error("Registration error:", err);
      setRegisterError("An unexpected error occurred. Please try again.");
      setIsRegistering(false);
    }
  }

  return (
    <Card className="bg-white">
      <CardHeader className="text-center pb-2">
        <CardTitle className="text-lg">Vehicle Service Platform</CardTitle>
        <CardDescription className="text-xs">
          Manage vehicle inspections, repairs, and verified service records
        </CardDescription>
      </CardHeader>

      <CardContent className="pt-2">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-2 mb-4">
            <TabsTrigger value="login">Sign in</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>

          {/* Login Tab */}
          <TabsContent value="login">
            <form onSubmit={handleLogin} className="space-y-4">
              {loginError && (
                <div
                  className="p-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs"
                  role="alert"
                >
                  {loginError}
                </div>
              )}

              <div>
                <Label htmlFor="login-email" required>
                  Email address
                </Label>
                <Input
                  id="login-email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="name@example.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="login-password" required>
                  Password
                </Label>
                <Input
                  id="login-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                />
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full mt-2"
                isLoading={isLoggingIn}
              >
                Sign in to ServiceTrack
              </Button>
            </form>
          </TabsContent>

          {/* Register Tab */}
          <TabsContent value="register">
            <form onSubmit={handleRegister} className="space-y-4">
              {registerError && (
                <div
                  className="p-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs"
                  role="alert"
                >
                  {registerError}
                </div>
              )}

              {registerSuccess && (
                <div
                  className="flex items-center gap-2 p-3 rounded-lg border border-green-200 bg-green-50 text-green-800 text-xs"
                  role="status"
                >
                  <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                  <span>{registerSuccess}</span>
                </div>
              )}

              {/* Role Selector */}
              <div>
                <Label>Account type</Label>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => setRole("customer")}
                    className={`flex flex-col items-center justify-center p-3 rounded-lg border text-xs font-medium transition-all touch-target ${
                      role === "customer"
                        ? "border-[#2563eb] bg-blue-50/50 text-[#2563eb]"
                        : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <span className="font-semibold">Customer</span>
                    <span className="text-[10px] text-gray-500 mt-0.5">Book car services</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setRole("mechanic")}
                    className={`flex flex-col items-center justify-center p-3 rounded-lg border text-xs font-medium transition-all touch-target ${
                      role === "mechanic"
                        ? "border-[#2563eb] bg-blue-50/50 text-[#2563eb]"
                        : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <span className="font-semibold">Mechanic</span>
                    <span className="text-[10px] text-gray-500 mt-0.5">Invite code required</span>
                  </button>
                </div>
              </div>

              <div>
                <Label htmlFor="reg-name" required>
                  Full name
                </Label>
                <Input
                  id="reg-name"
                  type="text"
                  required
                  placeholder="Jane Doe"
                  value={registerName}
                  onChange={(e) => setRegisterName(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="reg-email" required>
                  Email address
                </Label>
                <Input
                  id="reg-email"
                  type="email"
                  required
                  placeholder="jane@example.com"
                  value={registerEmail}
                  onChange={(e) => setRegisterEmail(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="reg-password" required>
                  Password (min 8 characters)
                </Label>
                <Input
                  id="reg-password"
                  type="password"
                  required
                  minLength={8}
                  placeholder="••••••••"
                  value={registerPassword}
                  onChange={(e) => setRegisterPassword(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="reg-phone">Phone number (optional)</Label>
                <Input
                  id="reg-phone"
                  type="tel"
                  placeholder="+1 (555) 012-3456"
                  value={registerPhone}
                  onChange={(e) => setRegisterPhone(e.target.value)}
                />
              </div>

              {role === "mechanic" && (
                <div className="pt-1">
                  <Label htmlFor="reg-invite" required>
                    Mechanic Invite Code
                  </Label>
                  <div className="relative">
                    <Input
                      id="reg-invite"
                      type="text"
                      required
                      placeholder="Enter invite code"
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                    />
                    <div className="absolute right-3 top-3 text-gray-400 pointer-events-none">
                      <Shield className="w-4 h-4" />
                    </div>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-500">
                    Provided by garage administration.
                  </p>
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                className="w-full mt-2"
                isLoading={isRegistering}
              >
                Create {role === "mechanic" ? "Mechanic" : "Customer"} Account
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export default function AuthPage() {
  return (
    <div className="min-h-screen flex flex-col justify-center items-center px-4 py-12 bg-gray-50/50">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-9 h-9 rounded-lg bg-[#2563eb] text-white flex items-center justify-center">
            <Wrench className="w-5 h-5" />
          </div>
          <span className="font-bold text-xl text-gray-900 tracking-tight">ServiceTrack</span>
        </div>

        <React.Suspense
          fallback={
            <Card className="bg-white p-8 flex flex-col items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </Card>
          }
        >
          <AuthContent />
        </React.Suspense>
      </div>
    </div>
  );
}
