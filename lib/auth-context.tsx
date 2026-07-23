"use client";

import { createContext, useContext, useState, useEffect } from "react";

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if user is already logged in
    const stored = localStorage.getItem("triapp_user");
    if (stored) {
      setUser(JSON.parse(stored));
    }
    setIsLoading(false);
  }, []);

  const signup = async (email: string, password: string) => {
    const users = JSON.parse(localStorage.getItem("triapp_users") || "{}");
    if (users[email]) {
      throw new Error("User already exists");
    }
    users[email] = { password, id: Date.now().toString() };
    localStorage.setItem("triapp_users", JSON.stringify(users));
    
    const newUser = { id: users[email].id, email };
    setUser(newUser);
    localStorage.setItem("triapp_user", JSON.stringify(newUser));
  };

  const login = async (email: string, password: string) => {
    const users = JSON.parse(localStorage.getItem("triapp_users") || "{}");
    if (!users[email] || users[email].password !== password) {
      throw new Error("Invalid email or password");
    }
    
    const userData = { id: users[email].id, email };
    setUser(userData);
    localStorage.setItem("triapp_user", JSON.stringify(userData));
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem("triapp_user");
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
