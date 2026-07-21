import { lazy, Suspense } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { Login } from "@/pages/Login"
import { useAuth } from "@/hooks/useAuth"
import { AmbientCanvas } from "@/components/AmbientCanvas"

const Decks = lazy(() => import("@/pages/Decks").then((module) => ({ default: module.Decks })))
const Discover = lazy(() => import("@/pages/Discover").then((module) => ({ default: module.Discover })))
const CardSearch = lazy(() => import("@/pages/CardSearch").then((module) => ({ default: module.CardSearch })))
const Events = lazy(() => import("@/pages/Events").then((module) => ({ default: module.Events })))
const Life = lazy(() => import("@/pages/Life").then((module) => ({ default: module.Life })))
const Collections = lazy(() => import("@/pages/Collections").then((module) => ({ default: module.Collections })))
const Builder = lazy(() => import("@/pages/Builder").then((module) => ({ default: module.Builder })))
const Profile = lazy(() => import("@/pages/Profile").then((module) => ({ default: module.Profile })))
const DeckDetail = lazy(() => import("@/pages/DeckDetail").then((module) => ({ default: module.DeckDetail })))

function RouteFallback() {
  return <div className="flex min-h-dvh items-center justify-center"><img src="/logo.svg?v=mythic" alt="" className="h-14 w-14 animate-pulse" /></div>
}

function Gate() {
  const { user, isLoading } = useAuth()
  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <AmbientCanvas />
        <img src="/logo.svg?v=mythic" alt="Grimore" className="h-20 w-20 animate-pulse" />
      </div>
    )
  }
  if (!user) return <Login />
  return <AppShell />
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<Gate />}>
            <Route index element={<Navigate to="/discover" replace />} />
            <Route path="/decks" element={<Decks />} />
            <Route path="/discover" element={<Discover />} />
            <Route path="/discover/:deckId" element={<DeckDetail />} />
            <Route path="/search" element={<CardSearch />} />
            <Route path="/events" element={<Events />} />
            <Route path="/life" element={<Life />} />
            <Route path="/collections" element={<Collections />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/builder/new" element={<Builder />} />
            <Route path="/builder/:deckId" element={<Builder />} />
            <Route path="*" element={<Navigate to="/discover" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
