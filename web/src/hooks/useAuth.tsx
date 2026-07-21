import { createContext, useContext, type ReactNode } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type Player } from "@/lib/api"

interface AuthStatus {
  loggedIn: boolean
  user?: Player
}

interface AuthContextValue {
  user: Player | null
  isLoading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (fields: {
    username: string
    password: string
    storeNickname: string
    email: string
  }) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()

  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api.get<AuthStatus>("/api/auth/status"),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })

  const loginMutation = useMutation({
    mutationFn: (body: { username: string; password: string }) =>
      api.post<{ success: boolean; user: Player }>("/api/auth/login", body),
    onSuccess: () => qc.invalidateQueries(),
  })

  const registerMutation = useMutation({
    mutationFn: (body: {
      username: string
      password: string
      storeNickname: string
      email: string
    }) => api.post<{ success: boolean }>("/api/auth/register", body),
  })

  const logoutMutation = useMutation({
    mutationFn: () => api.post("/api/auth/logout"),
    onSuccess: () => qc.invalidateQueries(),
  })

  const value: AuthContextValue = {
    user: status.data?.loggedIn && status.data.user ? status.data.user : null,
    isLoading: status.isPending,
    login: async (username, password) => {
      await loginMutation.mutateAsync({ username, password })
    },
    register: async (fields) => {
      await registerMutation.mutateAsync(fields)
    },
    logout: async () => {
      await logoutMutation.mutateAsync()
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
