import { useEffect, useState } from "react"
import { NavLink, Outlet, useLocation } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Compass,
  Heart,
  Layers,
  LayoutGrid,
  LogOut,
  Menu,
  Search,
  Trophy,
  UserRound,
} from "lucide-react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useAuth } from "@/hooks/useAuth"
import { AmbientCanvas } from "@/components/AmbientCanvas"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const NAV = [
  { to: "/discover", label: "Discover", short: "Discover", icon: Compass },
  { to: "/decks", label: "My Decks", short: "Decks", icon: Layers },
  { to: "/search", label: "Card Search", short: "Search", icon: Search },
  { to: "/collections", label: "Collections", short: "Binder", icon: LayoutGrid },
  { to: "/events", label: "League & Events", short: "Events", icon: Trophy },
  { to: "/life", label: "Life Tracker", short: "Life", icon: Heart },
]

const MOBILE_NAV = NAV.filter((item) => ["/discover", "/decks", "/search", "/life"].includes(item.to))

interface Notification {
  id: string
  title?: string
  message?: string
  type?: string
  read_status?: number
  created_at?: string
}

function NotificationsButton({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const notifications = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<Notification[]>("/api/notifications"),
  })
  const markRead = useMutation({
    mutationFn: (id: string) => api.post("/api/notifications/read", { id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  })
  const unread = (notifications.data ?? []).filter((item) => item.read_status !== 1).length

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size={compact ? "icon" : "default"}
        className={cn("relative", !compact && "w-full justify-start px-3")}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => setOpen(true)}
      >
        <Bell />
        {!compact && <span>Notifications</span>}
        {unread > 0 && (
          <span className={cn("flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.6rem] font-bold leading-none text-primary-foreground", compact ? "absolute right-1 top-1" : "ml-auto")}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
        {!compact && <span className="sr-only">Open notifications</span>}
      </Button>
      <SheetContent className="w-[min(92vw,420px)] p-0">
        <SheetHeader className="border-b border-border px-5 py-5">
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription>League updates, social activity, and deck alerts.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-3">
          {notifications.isPending ? (
            <div className="space-y-2" aria-label="Loading notifications">
              {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-20 animate-pulse rounded-xl bg-muted" />)}
            </div>
          ) : notifications.isError ? (
            <p className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">Notifications could not be loaded.</p>
          ) : (notifications.data ?? []).length === 0 ? (
            <div className="py-16 text-center">
              <Bell className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 font-semibold">You’re all caught up</p>
              <p className="mt-1 text-sm text-muted-foreground">New league and community activity will appear here.</p>
            </div>
          ) : (
            <ul className="space-y-1">
              {(notifications.data ?? []).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={cn(
                      "w-full rounded-xl px-4 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      item.read_status !== 1 && "bg-primary/8"
                    )}
                    onClick={() => item.read_status !== 1 && markRead.mutate(item.id)}
                  >
                    <span className="flex items-start gap-3">
                      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", item.read_status !== 1 ? "bg-primary" : "bg-muted-foreground/30")} />
                      <span className="min-w-0">
                        <strong className="block text-sm">{item.title || item.type || "Grimore update"}</strong>
                        {item.message && <span className="mt-0.5 block text-sm text-muted-foreground">{item.message}</span>}
                        {item.created_at && <span className="mt-1 block text-xs text-muted-foreground">{new Date(item.created_at).toLocaleString()}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function MobileMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[min(88vw,360px)] p-0">
        <SheetHeader className="border-b border-border p-5 text-left">
          <div className="flex items-center gap-3">
            <img src="/logo.svg?v=mythic" alt="" className="size-11" />
            <div>
              <SheetTitle className="font-display text-xl">Grimore</SheetTitle>
              <SheetDescription>Your complete Commander table.</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="All destinations">
          {NAV.map(({ to, label, icon: Icon }) => {
            const isActive = location.pathname.startsWith(to)
            return (
              <SheetClose asChild key={to}>
                <NavLink
                  to={to}
                  className={cn("flex min-h-12 items-center gap-3 rounded-[10px] px-3 font-medium text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground", isActive && "bg-primary/10 text-foreground")}
                >
                  <Icon className={cn("size-5", isActive && "text-primary")} />
                  <span>{label}</span>
                </NavLink>
              </SheetClose>
            )
          })}
        </nav>
        <div className="border-t border-border p-3">
          <SheetClose asChild>
            <NavLink to="/profile" className="flex min-h-12 items-center gap-3 rounded-xl px-3 font-medium hover:bg-accent/60">
              {user?.avatarUrl ? <img src={user.avatarUrl} alt="" className="size-8 rounded-full object-cover" /> : <UserRound className="size-5" />}
              <span className="min-w-0 flex-1 truncate">{user?.storeNickname || user?.username || "Profile & settings"}</span>
            </NavLink>
          </SheetClose>
          <button type="button" onClick={() => void logout()} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
            <LogOut className="size-5" /> Log out
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function AppShell() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const immersive = location.pathname.startsWith("/life") || location.pathname.startsWith("/builder")
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("grimore.sidebar.collapsed.v2") === "true")
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const routeTitle = NAV.find((item) => location.pathname.startsWith(item.to))?.label
    ?? (location.pathname.startsWith("/profile") ? "Profile & settings" : "Grimore")

  useEffect(() => {
    localStorage.setItem("grimore.sidebar.collapsed.v2", String(collapsed))
  }, [collapsed])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 })
  }, [location.pathname])

  return (
    <div className="min-h-dvh">
      <AmbientCanvas />

      {!immersive && (
        <aside className={cn("app-sidebar fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-sidebar-border bg-sidebar/88 py-3 backdrop-blur-2xl transition-[width] duration-200 md:flex", collapsed ? "w-[68px]" : "w-[224px]")}>
          <div className={cn("app-sidebar-brand mb-3 flex h-12 items-center", collapsed ? "justify-center" : "px-3")}>
            <NavLink to="/discover" className="flex min-w-0 items-center gap-3" aria-label="Grimore home">
              <img src="/logo.svg?v=mythic" alt="" className="size-10 shrink-0" />
              {!collapsed && <span className="truncate font-display text-[1.15rem] font-semibold">Grimore</span>}
            </NavLink>
          </div>

          <nav className="app-sidebar-nav flex flex-1 flex-col gap-0.5 px-2" aria-label="Primary">
            {NAV.map(({ to, label, icon: Icon }) => {
              const isActive = location.pathname.startsWith(to)
              return (
                <Tooltip key={to} delayDuration={collapsed ? 250 : 1000}>
                  <TooltipTrigger asChild>
                    <NavLink
                      to={to}
                      aria-label={collapsed ? label : undefined}
                      className={cn("app-sidebar-link flex min-h-10 items-center gap-3 rounded-[10px] px-3 text-[0.9rem] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground", collapsed && "min-h-11 justify-center px-0", isActive && "is-active bg-primary/10 text-foreground")}
                    >
                      <Icon className="size-5 shrink-0" strokeWidth={1.8} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </NavLink>
                  </TooltipTrigger>
                  {collapsed && <TooltipContent side="right">{label}</TooltipContent>}
                </Tooltip>
              )
            })}
          </nav>

          <div className="app-sidebar-footer space-y-0.5 border-t border-sidebar-border px-2 pt-2">
            <NotificationsButton compact={collapsed} />
            <NavLink to="/profile" aria-label={collapsed ? "Profile and settings" : undefined} className={({ isActive }) => cn("app-sidebar-link flex min-h-10 items-center gap-3 rounded-[10px] px-3 text-[0.9rem] font-medium text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground", collapsed && "min-h-11 justify-center px-0", isActive && "is-active bg-primary/10 text-foreground")}>
              {user?.avatarUrl ? <img src={user.avatarUrl} alt="" className="size-8 shrink-0 rounded-full object-cover" /> : <UserRound className="size-5 shrink-0" />}
              {!collapsed && <span className="min-w-0 flex-1 truncate">{user?.storeNickname || user?.username || "Profile"}</span>}
            </NavLink>
            <button type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} className={cn("app-sidebar-link flex min-h-10 w-full items-center gap-3 rounded-[10px] px-3 text-[0.9rem] font-medium text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground", collapsed && "min-h-11 justify-center px-0")}>
              {collapsed ? <ChevronRight className="size-5 shrink-0" /> : <ChevronLeft className="size-5 shrink-0" />}
              {!collapsed && <span>Collapse</span>}
            </button>
            <button type="button" onClick={() => void logout()} aria-label={collapsed ? "Log out" : undefined} className={cn("app-sidebar-link flex min-h-10 w-full items-center gap-3 rounded-[10px] px-3 text-[0.9rem] font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive", collapsed && "min-h-11 justify-center px-0")}>
              <LogOut className="size-5 shrink-0" />
              {!collapsed && <span>Log out</span>}
            </button>
          </div>
        </aside>
      )}

      {!immersive && (
        <header className="app-mobile-header fixed inset-x-0 top-0 z-40 flex h-[52px] items-center justify-between border-b border-border bg-background/88 px-2 backdrop-blur-2xl md:hidden">
          <button type="button" className="flex min-h-11 min-w-0 items-center gap-2 rounded-[10px] px-1.5 text-left" aria-label="Open navigation" onClick={() => setMobileMenuOpen(true)}>
            <img src="/logo.svg?v=mythic" alt="" className="size-9 shrink-0" />
            <span className="truncate text-[0.92rem] font-semibold">{routeTitle}</span>
          </button>
          <NotificationsButton compact />
          <MobileMenu open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} />
        </header>
      )}

      <main className={cn("app-main min-h-dvh transition-[padding] duration-200", !immersive && (collapsed ? "md:pl-[68px]" : "md:pl-[224px]"), !immersive && "pt-[52px] pb-[calc(62px+env(safe-area-inset-bottom))] md:pt-0 md:pb-0")}>
        <Outlet />
      </main>

      {!immersive && (
        <nav aria-label="Primary" className="app-mobile-nav fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-background/90 px-1 backdrop-blur-2xl pb-safe md:hidden">
          {MOBILE_NAV.map(({ to, short, icon: Icon }) => (
            <NavLink key={to} to={to} aria-label={short} className={({ isActive }) => cn("flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[0.64rem] font-semibold text-muted-foreground transition-colors active:scale-95", isActive && "is-active text-foreground")}>
              <Icon className="size-5" strokeWidth={1.8} />
              <span>{short}</span>
            </NavLink>
          ))}
          <button type="button" aria-label="More destinations" onClick={() => setMobileMenuOpen(true)} className="flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[0.64rem] font-semibold text-muted-foreground transition-colors hover:text-foreground active:scale-95">
            <Menu className="size-5" /><span>More</span>
          </button>
        </nav>
      )}
    </div>
  )
}
