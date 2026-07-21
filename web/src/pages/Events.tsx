import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, CheckCircle2, LogOut, Medal, Swords, Trophy, Users } from "lucide-react"
import { toast } from "sonner"
import { api, type Deck, type Season } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeader } from "@/components/PageHeader"
import { WorkspaceState } from "@/components/WorkspaceState"
import { useAuth } from "@/hooks/useAuth"

interface LeaderboardRow { player_id?: string; store_nickname?: string; total_points?: number; total_wins?: number; total_kills?: number; total_matches?: number }
interface RosterStatus { checkedIn: boolean; deckId: string | null }
interface MatchPlayer { player_id: string; store_nickname: string; deck_name?: string; kills?: number; placed_first?: number }
interface ActiveMatch { hasActiveMatch: boolean; roundNum?: number; completed?: boolean; podId?: string; podLabel?: number; players?: MatchPlayer[] }

export function Events() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [selectedDeck, setSelectedDeck] = useState("")
  const season = useQuery({ queryKey: ["active-season"], queryFn: () => api.get<Season | null>("/api/seasons/active") })
  const leaderboard = useQuery({ queryKey: ["season-leaderboard"], queryFn: () => api.get<LeaderboardRow[]>("/api/leaderboards/season"), enabled: !!season.data })
  const roster = useQuery({ queryKey: ["roster-status"], queryFn: () => api.get<RosterStatus>("/api/roster/status") })
  const decks = useQuery({ queryKey: ["my-decks"], queryFn: () => api.get<Deck[]>("/api/decks/my-decks") })
  const match = useQuery({ queryKey: ["active-match"], queryFn: () => api.get<ActiveMatch>("/api/players/active-match"), enabled: !!season.data, refetchInterval: 30000 })

  useEffect(() => { if (roster.data?.deckId) setSelectedDeck(roster.data.deckId) }, [roster.data])

  const join = useMutation({ mutationFn: (seasonId: string) => api.post(`/api/seasons/${seasonId}/register`), onSuccess: () => { toast.success("Registered for the season"); void qc.invalidateQueries({ queryKey: ["season-leaderboard"] }) }, onError: (error) => toast.error(error instanceof Error ? error.message : "Could not register") })
  const checkIn = useMutation({ mutationFn: () => api.post("/api/roster/checkin", { deckId: selectedDeck }), onSuccess: () => { toast.success("Checked in and ready for pairings"); void qc.invalidateQueries({ queryKey: ["roster-status"] }) }, onError: (error) => toast.error(error instanceof Error ? error.message : "Could not check in") })
  const checkOut = useMutation({ mutationFn: () => api.post("/api/roster/checkout"), onSuccess: () => { toast.success("Checked out"); setSelectedDeck(""); void qc.invalidateQueries({ queryKey: ["roster-status"] }) }, onError: (error) => toast.error(error instanceof Error ? error.message : "Could not check out") })

  const s = season.data
  const name = s?.name ?? s?.season_name ?? "Commander League"
  const isRegistered = (leaderboard.data ?? []).some((row) => row.player_id === user?.id)

  return (
    <div className="page-wrap">
      <PageHeader title="League & Events" description="Register, check in a legal deck, find your pod, and follow the standings." />
      {season.isPending ? <div className="space-y-4"><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-72 rounded-xl" /></div> : !s ? (
        <WorkspaceState icon={<CalendarDays />} title="No league is open right now" description="Registration, check-in, pairings, and standings will appear here when the next season starts. Prepare a legal deck now so event-night check-in takes seconds." actions={<><Button asChild><Link to="/builder/new">Build a deck</Link></Button><Button variant="secondary" asChild><Link to="/decks">Review my decks</Link></Button></>} />
      ) : (
        <>
          <section className="surface-panel mb-5 rounded-xl p-5 md:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div><div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-2xl font-semibold md:text-3xl">{name}</h2><Badge className="bg-emerald-500/15 text-emerald-300">Active</Badge></div><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Join the season once, then check in with the deck you’re playing each event night.</p></div>
              <Button onClick={() => join.mutate(s.id)} disabled={join.isPending || isRegistered}>{isRegistered ? <CheckCircle2 /> : <Trophy />} {join.isPending ? "Registering…" : isRegistered ? "Joined" : "Join season"}</Button>
            </div>
          </section>

          {match.data?.hasActiveMatch && (
            <section className="mb-5 rounded-xl bg-accent px-5 py-4 text-accent-foreground">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold">Round {match.data.roundNum} · Table {match.data.podLabel}</p><h2 className="mt-1 text-xl font-bold">Your pod is ready</h2><p className="mt-1 text-sm opacity-80">{(match.data.players ?? []).map((player) => player.store_nickname).join(" · ")}</p></div><Button asChild><Link to="/life"><Swords /> Open life tracker</Link></Button></div>
            </section>
          )}

          <Tabs defaultValue="checkin">
            <TabsList className="mb-4 w-full justify-start overflow-x-auto" variant="line"><TabsTrigger value="checkin"><CheckCircle2 /> Check-in</TabsTrigger><TabsTrigger value="standings"><Medal /> Standings</TabsTrigger><TabsTrigger value="pod"><Users /> My pod</TabsTrigger></TabsList>
            <TabsContent value="checkin">
              <section className="grid gap-8 border-t border-border pt-5 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
                <div><h2 className="text-lg font-semibold">Event-night check-in</h2>
                <p className="mt-1 text-sm text-muted-foreground">Select the deck you are bringing. Organizers use this roster to generate pods.</p>
                {roster.data?.checkedIn ? <div className="mt-5 flex flex-col gap-3 rounded-xl bg-emerald-500/10 p-4 sm:flex-row sm:items-center"><CheckCircle2 className="size-6 text-emerald-400" /><div className="min-w-0 flex-1"><strong className="block">You’re checked in</strong><span className="text-sm text-muted-foreground">{decks.data?.find((deck) => deck.id === roster.data?.deckId)?.deck_name || "Selected deck"}</span></div><Button variant="secondary" onClick={() => checkOut.mutate()} disabled={checkOut.isPending}><LogOut /> Check out</Button></div> : (decks.data ?? []).length > 0 ? <div className="mt-5 flex flex-col gap-2 sm:flex-row"><Select value={selectedDeck} onValueChange={setSelectedDeck}><SelectTrigger className="w-full flex-1" aria-label="Deck for event check-in"><SelectValue placeholder="Choose your deck" /></SelectTrigger><SelectContent>{(decks.data ?? []).map((deck) => <SelectItem key={deck.id} value={deck.id}>{deck.deck_name}</SelectItem>)}</SelectContent></Select><Button disabled={!selectedDeck || checkIn.isPending} onClick={() => checkIn.mutate()}><CheckCircle2 /> Check in</Button></div> : <div className="mt-5 flex flex-col gap-3 border-y border-border py-5"><p className="text-sm text-muted-foreground">You need a deck before you can join the event-night roster.</p><div className="flex flex-wrap gap-2"><Button asChild><Link to="/builder/new">Build a deck</Link></Button><Button variant="secondary" asChild><Link to="/decks">Import a deck</Link></Button></div></div>}</div>
                <aside className="border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"><h3 className="text-sm font-semibold">Before you arrive</h3><ol className="mt-3 space-y-3 text-sm text-muted-foreground"><li className="flex gap-3"><span className="font-mono text-primary">1</span><span>Choose the exact deck you are playing.</span></li><li className="flex gap-3"><span className="font-mono text-primary">2</span><span>Check in when the organizer opens the roster.</span></li><li className="flex gap-3"><span className="font-mono text-primary">3</span><span>Open My pod when pairings are posted.</span></li></ol></aside>
              </section>
            </TabsContent>
            <TabsContent value="standings">
              <section className="overflow-hidden rounded-xl border border-border bg-card/65"><div className="grid grid-cols-[44px_1fr_auto_auto] gap-3 border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground"><span>#</span><span>Player</span><span>Record</span><span>Points</span></div>{leaderboard.isPending ? <div className="space-y-2 p-3">{Array.from({length:6}).map((_, index) => <Skeleton key={index} className="h-11" />)}</div> : (leaderboard.data ?? []).length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">Standings appear after the first reported round.</p> : <ol>{(leaderboard.data ?? []).slice(0,30).map((row,index) => <li key={row.player_id ?? index} className="grid min-h-12 grid-cols-[44px_1fr_auto_auto] items-center gap-3 border-b border-border px-3 text-sm last:border-0"><span className="font-mono font-bold text-primary">{index+1}</span><span className="truncate font-medium">{row.store_nickname || "Player"}</span><span className="font-mono text-xs text-muted-foreground">{row.total_wins ?? 0}W · {row.total_kills ?? 0}K</span><span className="min-w-16 text-right font-mono font-bold">{row.total_points ?? 0}</span></li>)}</ol>}</section>
            </TabsContent>
            <TabsContent value="pod">{match.isPending ? <Skeleton className="h-48 rounded-xl" /> : !match.data?.hasActiveMatch ? <div className="py-14 text-center"><Users className="mx-auto size-9 text-muted-foreground" /><h2 className="mt-3 font-semibold">No active pairing yet</h2><p className="mt-1 text-sm text-muted-foreground">Check in and wait for the organizer to post the next round.</p></div> : <div className="grid gap-3 sm:grid-cols-2">{(match.data.players ?? []).map((player) => <article key={player.player_id} className="rounded-xl border border-border bg-card/70 p-4"><strong>{player.store_nickname}</strong><p className="mt-1 text-sm text-muted-foreground">{player.deck_name || "Deck not submitted"}</p></article>)}</div>}</TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
