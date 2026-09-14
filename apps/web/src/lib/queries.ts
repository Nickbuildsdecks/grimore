/**
 * TanStack Query layer over `apiClient`.
 *
 * Query keys live in one factory so an invalidation cannot miss a cache entry by spelling its key
 * slightly differently at the call site — the bug class this file exists to prevent.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query"
import type { AuthStatus, Deck, DeckSummary, LoginInput, MePlayer, RegisterInput } from "@grimore/shared"
import { ApiError, apiClient, type DiscoverParams, type Paginated } from "./apiClient"

export const queryKeys = {
  auth: {
    all: ["auth"] as const,
    status: () => [...queryKeys.auth.all, "status"] as const,
  },
  decks: {
    all: ["decks"] as const,
    mine: () => [...queryKeys.decks.all, "mine"] as const,
    discover: (params: DiscoverParams) => [...queryKeys.decks.all, "discover", params] as const,
    detail: (deckId: string) => [...queryKeys.decks.all, "detail", deckId] as const,
  },
} as const

/**
 * A 401 is the server's answer, not a transport failure: retrying it just delays showing the login
 * screen. Same for the other 4xx codes — the request will not succeed by being repeated.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
  return failureCount < 2
}

export function useAuthStatus() {
  return useQuery({
    queryKey: queryKeys.auth.status(),
    queryFn: () => apiClient.auth.status(),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetry,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: LoginInput) => apiClient.auth.login(body),
    onSuccess: (data) => {
      // Seed the status cache from the login response so the app does not flash a logged-out shell
      // while a refetch is in flight.
      const next: AuthStatus = { loggedIn: true, user: data.user, googleClientId: "" }
      qc.setQueryData(queryKeys.auth.status(), next)
      // Everything else was fetched as an anonymous visitor and is now wrong.
      void qc.invalidateQueries()
    },
  })
}

export function useRegister() {
  return useMutation({ mutationFn: (body: RegisterInput) => apiClient.auth.register(body) })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.auth.logout(),
    // clear(), not invalidate(): the previous user's decks and collections must not stay readable in
    // the cache while the refetches are in flight.
    onSuccess: () => qc.clear(),
  })
}

export function useMyDecks(options?: Partial<UseQueryOptions<DeckSummary[], ApiError>>) {
  return useQuery<DeckSummary[], ApiError>({
    queryKey: queryKeys.decks.mine(),
    queryFn: () => apiClient.decks.mine(),
    retry: shouldRetry,
    ...options,
  })
}

export function useDiscoverDecks(params: DiscoverParams) {
  return useQuery<Paginated<DeckSummary>, ApiError>({
    queryKey: queryKeys.decks.discover(params),
    queryFn: () => apiClient.decks.discover(params),
    retry: shouldRetry,
  })
}

export function useDeck(deckId: string | undefined) {
  return useQuery<Deck, ApiError>({
    queryKey: queryKeys.decks.detail(deckId ?? ""),
    queryFn: () => apiClient.decks.byId(deckId!),
    enabled: Boolean(deckId),
    retry: shouldRetry,
  })
}

export function useDeleteDeck() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (deckId: string) => apiClient.decks.remove(deckId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.decks.all }),
  })
}

export function useImportMoxfieldDeck() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (moxfieldUrl: string) => apiClient.decks.importMoxfield(moxfieldUrl),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.decks.all }),
  })
}

/** The message to show a user for a failed request. */
export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export type { MePlayer }
