/**
 * Session state, backed by `apps/api` through the typed client.
 *
 * The player shape is `MePlayer` from @grimore/shared — snake_case, matching the database columns and
 * the API contract. The previous camelCase `Player` interface (storeNickname / isAdmin / avatarUrl) was
 * hand-maintained and did not match what any server actually returns.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { LoginInput, MePlayer, RegisterInput } from "@grimore/shared"
import { useAuthStatus, useLogin, useLogout, useRegister } from "@/lib/queries"

interface AuthContextValue {
  user: MePlayer | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (username: string, password: string) => Promise<void>
  register: (fields: RegisterInput) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const status = useAuthStatus()
  const loginMutation = useLogin()
  const registerMutation = useRegister()
  const logoutMutation = useLogout()

  const user = status.data?.loggedIn ? status.data.user : null

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading: status.isPending,
      isAuthenticated: Boolean(user),
      login: async (username: string, password: string) => {
        await loginMutation.mutateAsync({ username, password } as LoginInput)
      },
      register: async (fields: RegisterInput) => {
        await registerMutation.mutateAsync(fields)
      },
      logout: async () => {
        await logoutMutation.mutateAsync()
      },
    }),
    [user, status.isPending, loginMutation, registerMutation, logoutMutation],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
