"use client";

import { type FormEvent, useState } from "react";
import { Button } from "@/components/Button";
import { Button as UIButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastError } from "@/components/Toast";
import { signIn, signUp } from "@/utils/auth-client";
import { redirectToSafeUrl } from "@/utils/redirect";

export function PasswordLoginForm({ callbackURL }: { callbackURL: string }) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));

    setIsLoading(true);
    const { error } = isSignUp
      ? await signUp.email({ email, password, name: email.split("@")[0] })
      : await signIn.email({ email, password });
    setIsLoading(false);

    if (error) {
      toastError({
        title: isSignUp ? "Could not sign up" : "Could not sign in",
        description: error.message ?? "Please check your details.",
      });
      return;
    }

    redirectToSafeUrl(callbackURL);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 pb-2">
      <Input
        name="email"
        type="email"
        placeholder="Email"
        aria-label="Email"
        autoComplete="email"
        required
      />
      <Input
        name="password"
        type="password"
        placeholder="Password"
        aria-label="Password"
        autoComplete={isSignUp ? "new-password" : "current-password"}
        minLength={12}
        required
      />
      <Button type="submit" loading={isLoading}>
        {isSignUp ? "Create account" : "Sign in"}
      </Button>
      <UIButton
        type="button"
        variant="link"
        size="sm"
        onClick={() => setIsSignUp((current) => !current)}
      >
        {isSignUp ? "I already have an account" : "Create an account"}
      </UIButton>
    </form>
  );
}
