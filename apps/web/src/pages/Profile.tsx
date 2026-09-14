import { useEffect, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Eye, EyeOff, KeyRound, Save, ShieldCheck, UserRound } from "lucide-react"
import { toast } from "sonner"
import { api, type CardResult, type Deck } from "@/lib/api"
import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { showcaseImage, useShowcaseCards } from "@/hooks/useShowcaseCards"
import { cn } from "@/lib/utils"

interface ProfileData {
  profile: { id: string; store_nickname: string; username: string; email: string; avatar_url: string | null; profile_commander: string | null; profile_bio: string | null; featured_deck_id: string | null }
  stats?: { total_points?: number; total_wins?: number; total_kills?: number; total_matches?: number }
  publicDecks?: Deck[]
}
interface ProfileDraft { storeNickname: string; avatarUrl: string; profileCommander: string; profileBio: string; featuredDeckId: string }
const EMPTY: ProfileDraft = { storeNickname: "", avatarUrl: "", profileCommander: "", profileBio: "", featuredDeckId: "none" }

export function Profile() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY)
  const [account, setAccount] = useState({ username: "", email: "", password: "", confirmPassword: "" })
  const [showPassword, setShowPassword] = useState(false)
  const [commanderPickerOpen, setCommanderPickerOpen] = useState(false)
  const profile = useQuery({ queryKey: ["profile", user?.id], queryFn: () => api.get<ProfileData>(`/api/players/${user!.id}/profile`), enabled: !!user })
  const decks = useQuery({ queryKey: ["my-decks"], queryFn: () => api.get<Deck[]>("/api/decks/my-decks") })
  const featuredDeck = (decks.data ?? []).find((deck) => deck.id === draft.featuredDeckId)
  const showcase = useShowcaseCards({
    preferred: featuredDeck?.commander_scryfall_id ? [{ name: featuredDeck.commander_name || featuredDeck.deck_name, scryfallId: featuredDeck.commander_scryfall_id }] : [],
    fallbackQuery: profile.data?.profile.profile_commander?.trim() || "is:commander game:paper usd<25",
    limit: 3,
    enabled: Boolean(featuredDeck?.commander_scryfall_id || profile.data?.profile.profile_commander?.trim()),
  })
  const commanderSearch = useQuery({
    queryKey: ["profile-commander-search", draft.profileCommander],
    queryFn: () => api.get<{ cards: CardResult[] }>(`/api/cards/search?q=${encodeURIComponent(draft.profileCommander)}&page=1&limit=6`),
    enabled: draft.profileCommander.trim().length >= 2 && draft.profileCommander !== profile.data?.profile.profile_commander,
  })
  const commanderCandidates = (commanderSearch.data?.cards ?? []).filter((card) => card.type_line.includes("Legendary Creature") || card.oracle_text?.toLowerCase().includes("can be your commander"))

  useEffect(() => {
    const p = profile.data?.profile
    if (!p) return
    setDraft({ storeNickname: p.store_nickname ?? "", avatarUrl: p.avatar_url ?? "", profileCommander: p.profile_commander ?? "", profileBio: p.profile_bio ?? "", featuredDeckId: p.featured_deck_id ?? "none" })
    setAccount((current) => ({ ...current, username: p.username ?? "", email: p.email ?? "" }))
  }, [profile.data])

  const saveProfile = useMutation({
    mutationFn: () => api.post("/api/players/profile/update", { ...draft, featuredDeckId: draft.featuredDeckId === "none" ? null : draft.featuredDeckId }),
    onSuccess: () => { toast.success("Profile saved"); void qc.invalidateQueries({ queryKey: ["profile"] }); void qc.invalidateQueries({ queryKey: ["auth-status"] }) },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save profile"),
  })
  const saveAccount = useMutation({
    mutationFn: () => api.post("/api/players/account/update", { newUsername: account.username.trim(), newEmail: account.email.trim(), newPassword: account.password }),
    onSuccess: () => { toast.success("Account credentials updated"); setAccount((current) => ({ ...current, password: "", confirmPassword: "" })); void qc.invalidateQueries({ queryKey: ["auth-status"] }); void qc.invalidateQueries({ queryKey: ["profile"] }) },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update account"),
  })

  function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (account.password !== account.confirmPassword) { toast.error("Passwords do not match"); return }
    saveAccount.mutate()
  }

  if (profile.isPending) return <div className="page-wrap space-y-4"><Skeleton className="h-32 rounded-xl" /><Skeleton className="h-96 rounded-xl" /></div>
  if (profile.isError) return <div className="page-wrap"><section className="rounded-xl border border-destructive/30 bg-destructive/10 p-6"><h1 className="font-semibold">Profile could not be loaded</h1><Button variant="secondary" className="mt-4" onClick={() => void profile.refetch()}>Try again</Button></section></div>

  const stats = profile.data?.stats
  return (
    <div className="page-wrap">
      <header className={cn("profile-identity-header relative isolate mb-5 flex flex-col gap-4 overflow-hidden border-b border-border px-1 py-4 sm:min-h-36 sm:flex-row sm:items-end sm:px-5 sm:pt-10", showcase.cards[0] && "justify-end")}>
        {showcase.cards[0] && <img src={showcaseImage(showcase.cards[0])} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover object-[center_18%] opacity-35" />}
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-background via-background/82 to-background/38" />
        <div className="flex min-w-0 flex-1 items-center gap-4"><div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-primary/35 bg-card sm:size-20">{draft.avatarUrl ? <img src={draft.avatarUrl} alt="Profile avatar" className="h-full w-full object-cover" /> : <UserRound className="size-8 text-primary" />}</div><div className="min-w-0"><h1 className="truncate font-display text-3xl font-semibold">{draft.storeNickname || "Profile & settings"}</h1><p className="mt-1 truncate text-sm text-muted-foreground">@{profile.data?.profile.username} {draft.profileCommander && `· ${draft.profileCommander}`}</p></div></div>
        {stats && <dl className="profile-stat-strip grid grid-cols-3 text-center"><div><dt className="text-xs text-muted-foreground">Wins</dt><dd className="mt-1 font-mono text-lg font-bold">{stats.total_wins ?? 0}</dd></div><div><dt className="text-xs text-muted-foreground">Kills</dt><dd className="mt-1 font-mono text-lg font-bold">{stats.total_kills ?? 0}</dd></div><div><dt className="text-xs text-muted-foreground">Points</dt><dd className="mt-1 font-mono text-lg font-bold text-primary">{stats.total_points ?? 0}</dd></div></dl>}
      </header>

      <Tabs defaultValue="profile" orientation="horizontal">
        <TabsList variant="line" className="mb-5 h-11"><TabsTrigger value="profile"><ShieldCheck /> Public profile</TabsTrigger><TabsTrigger value="account"><KeyRound /> Account & security</TabsTrigger></TabsList>
        <TabsContent value="profile">
          <form className="max-w-4xl space-y-5" onSubmit={(event) => { event.preventDefault(); saveProfile.mutate() }}>
            <div><h2 className="text-lg font-semibold">Public identity</h2><p className="mt-1 text-sm text-muted-foreground">This information appears with public decks, league standings, and community activity.</p></div>
            <div className="grid gap-5 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="nickname">Display name</Label><Input id="nickname" value={draft.storeNickname} onChange={(event) => setDraft({ ...draft, storeNickname: event.target.value })} required /></div><div className="space-y-1.5"><Label htmlFor="avatar">Avatar</Label><Input id="avatar" type="url" value={draft.avatarUrl} onChange={(event) => setDraft({ ...draft, avatarUrl: event.target.value })} placeholder="Paste a direct image link" /><p className="text-xs text-muted-foreground">Use a direct JPG, PNG, or WebP URL.</p></div><div className="relative space-y-1.5"><Label htmlFor="commander">Signature commander</Label><Input id="commander" value={draft.profileCommander} onFocus={() => setCommanderPickerOpen(true)} onChange={(event) => { setDraft({ ...draft, profileCommander: event.target.value }); setCommanderPickerOpen(true) }} placeholder="Search by card name" autoComplete="off" />{commanderPickerOpen && draft.profileCommander.trim().length >= 2 && commanderCandidates.length ? <div className="absolute inset-x-0 top-[72px] z-30 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg">{commanderCandidates.map((card) => <button key={`${card.name}-${card.scryfallId}`} type="button" className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-secondary" onClick={() => { setDraft({ ...draft, profileCommander: card.name }); setCommanderPickerOpen(false) }}>{card.image_uri && <img src={card.image_uri} alt="" className="h-10 w-8 rounded object-cover" />}<span className="min-w-0"><strong className="block truncate text-sm">{card.name}</strong><span className="block truncate text-xs text-muted-foreground">{card.type_line}</span></span></button>)}</div> : null}</div><div className="space-y-1.5"><Label htmlFor="featured-deck">Featured deck</Label><Select value={draft.featuredDeckId} onValueChange={(value) => setDraft({ ...draft, featuredDeckId: value })}><SelectTrigger id="featured-deck" className="w-full" aria-label="Featured deck"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No featured deck</SelectItem>{(decks.data ?? []).map((deck) => <SelectItem key={deck.id} value={deck.id}>{deck.deck_name}</SelectItem>)}</SelectContent></Select></div></div>
            <div className="space-y-1.5"><div className="flex items-center justify-between"><Label htmlFor="bio">Bio</Label><span className="text-xs text-muted-foreground">{draft.profileBio.length}/500</span></div><Textarea id="bio" rows={5} maxLength={500} value={draft.profileBio} onChange={(event) => setDraft({ ...draft, profileBio: event.target.value })} placeholder="What do you like to play?" /></div>
            <Button type="submit" className="w-full sm:w-auto" disabled={saveProfile.isPending}><Save /> {saveProfile.isPending ? "Saving…" : "Save profile"}</Button>
          </form>
        </TabsContent>
        <TabsContent value="account">
          <form onSubmit={submitAccount} className="max-w-2xl space-y-6"><div><h2 className="text-lg font-semibold">Account credentials</h2><p className="mt-1 text-sm text-muted-foreground">Update your sign-in information. Leave the password blank to keep it unchanged.</p></div><div className="grid gap-5 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="username">Username</Label><Input id="username" value={account.username} onChange={(event) => setAccount({ ...account, username: event.target.value })} autoComplete="username" required /></div><div className="space-y-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={account.email} onChange={(event) => setAccount({ ...account, email: event.target.value })} autoComplete="email" required /></div><div className="space-y-1.5"><Label htmlFor="password">New password</Label><div className="relative"><Input id="password" type={showPassword ? "text" : "password"} value={account.password} onChange={(event) => setAccount({ ...account, password: event.target.value })} autoComplete="new-password" className="pr-12" /><Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff /> : <Eye />}</Button></div></div><div className="space-y-1.5"><Label htmlFor="confirm-password">Confirm new password</Label><Input id="confirm-password" type={showPassword ? "text" : "password"} value={account.confirmPassword} onChange={(event) => setAccount({ ...account, confirmPassword: event.target.value })} autoComplete="new-password" /></div></div><Button type="submit" disabled={saveAccount.isPending || !account.username.trim() || !account.email.trim()}>{saveAccount.isPending ? "Updating…" : "Update credentials"}</Button></form>
        </TabsContent>
      </Tabs>
    </div>
  )
}
