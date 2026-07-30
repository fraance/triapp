"use client";

import { createContext, useContext, useState, useEffect } from "react";
import { AUTH_COOKIE } from "@/lib/routes";

interface User {
  id: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_KEY = "triapp_session";

/**
 * Mirror "is someone signed in?" into a cookie so proxy.ts can redirect
 * unauthenticated requests at the edge instead of letting a protected page
 * render and then bounce. It contains no identity and grants no access -
 * API routes still verify the user themselves.
 */
function setAuthCookie(present: boolean) {
  if (typeof document === "undefined") return;
  document.cookie = present
    ? `${AUTH_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
    : `${AUTH_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Restore the logged-in user (the actual data lives in the database;
    // this only remembers which account is signed in on this device).
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) {
      try {
        setUser(JSON.parse(stored));
        setAuthCookie(true);
      } catch {
        localStorage.removeItem(SESSION_KEY);
        setAuthCookie(false);
      }
    } else {
      // Clear a stale cookie left behind if localStorage was wiped.
      setAuthCookie(false);
    }
    setIsLoading(false);
  }, []);

  const persist = (u: User) => {
    setUser(u);
    localStorage.setItem(SESSION_KEY, JSON.stringify(u));
    setAuthCookie(true);
  };

  const signup = async (email: string, password: string) => {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Signup failed");
    }
    persist({ id: data.id, email: data.email });
  };

  const login = async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Invalid email or password");
    }
    persist({ id: data.id, email: data.email });
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem(SESSION_KEY);
    setAuthCookie(false);
  };

  return (
    <AuthContext.Provider value={{ user, login, signup, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
