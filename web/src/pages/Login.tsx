import { useState, type FormEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/hooks/useAuth"
import { AmbientCanvas } from "@/components/AmbientCanvas"
import { api } from "@/lib/api"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function Login() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<"login" | "register">("login")
  const [busy, setBusy] = useState(false)
  const [forgotOpen, setForgotOpen] = useState(false)
  const [recoveryId, setRecoveryId] = useState("")
  const resetToken = new URLSearchParams(window.location.search).get("resetToken")

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    try {
      const response = await api.post<{ message?: string }>("/api/auth/forgot-password", { usernameOrEmail: recoveryId.trim() })
      toast.success(response.message || "Recovery link requested")
      setForgotOpen(false)
      setRecoveryId("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not request recovery")
    } finally { setBusy(false) }
  }

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const password = String(data.get("password") ?? "")
    const confirm = String(data.get("confirm") ?? "")
    if (password !== confirm) { toast.error("Passwords do not match"); return }
    setBusy(true)
    try {
      await api.post("/api/auth/reset-password", { token: resetToken, newPassword: password })
      toast.success("Password reset. You can sign in now.")
      window.history.replaceState({}, "", "/")
      window.location.reload()
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not reset password") }
    finally { setBusy(false) }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const username = String(fd.get("username") ?? "").trim()
    const password = String(fd.get("password") ?? "")
    setBusy(true)
    try {
      if (mode === "register") {
        await register({
          username,
          password,
          storeNickname: String(fd.get("nickname") ?? "").trim(),
          email: String(fd.get("email") ?? "").trim(),
        })
        toast.success("Registration successful. Welcome to Grimore.")
        await login(username, password)
      } else {
        await login(username, password)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center p-4">
      <AmbientCanvas />
      <div className="w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-card/75 backdrop-blur-xl md:grid md:grid-cols-2">
        {/* Brand panel */}
        <div className="flex flex-col items-center justify-center gap-4 border-b border-border p-10 md:border-b-0 md:border-r">
          <img src="/logo.svg?v=mythic" alt="" className="h-24 w-24 drop-shadow-[0_0_18px_rgb(168_85_247/0.55)]" />
          <h1 className="font-display text-4xl font-bold tracking-tight text-foreground">
            Grimore
          </h1>
          <p className="text-sm text-muted-foreground">A new way to experience MTG.</p>
        </div>

        {/* Form panel */}
        <div className="p-8 md:p-10">
          <h2 className="mb-6 text-center font-display text-2xl font-semibold text-brass-bright">
            {resetToken ? "Choose a new password" : mode === "login" ? "Welcome back" : "Create your account"}
          </h2>
          {resetToken ? <form onSubmit={submitReset} className="space-y-4"><div className="space-y-1.5"><Label htmlFor="reset-password">New password</Label><Input id="reset-password" name="password" type="password" autoComplete="new-password" minLength={8} required /></div><div className="space-y-1.5"><Label htmlFor="reset-confirm">Confirm password</Label><Input id="reset-confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required /></div><Button type="submit" className="w-full" disabled={busy}>{busy ? "Updating…" : "Reset password"}</Button></form> : <>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" autoComplete="username" required className="h-11" />
            </div>
            {mode === "login" && <button type="button" className="min-h-11 text-sm font-medium text-primary hover:underline" onClick={() => setForgotOpen(true)}>Forgot your password?</button>}
            {mode === "register" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="nickname">Nickname</Label>
                  <Input id="nickname" name="nickname" placeholder="e.g. Planeswalker Bob" required className="h-11" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" name="email" type="email" autoComplete="email" required className="h-11" />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                className="h-11"
              />
            </div>
            <Button type="submit" disabled={busy} className="h-11 w-full text-base font-bold glow-brass">
              {busy ? "One moment…" : mode === "login" ? "Access Grimore" : "Create Account"}
            </Button>
          </form>
          <p className="mt-5 text-center text-sm text-muted-foreground">
            {mode === "login" ? "New to Grimore?" : "Already registered?"}{" "}
            <button
              type="button"
              className="font-semibold text-brass-bright hover:underline"
              onClick={() => setMode(mode === "login" ? "register" : "login")}
            >
              {mode === "login" ? "Register" : "Back to Login"}
            </button>
          </p>
          </>}
        </div>
      </div>
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}><DialogContent><DialogHeader><DialogTitle>Recover your account</DialogTitle><DialogDescription>Enter your username or email. If the account exists, Grimore will generate a one-hour reset link.</DialogDescription></DialogHeader><form onSubmit={submitRecovery} className="space-y-4"><Input value={recoveryId} onChange={(event) => setRecoveryId(event.target.value)} placeholder="Username or email" aria-label="Username or email" required /><Button type="submit" className="w-full" disabled={busy || !recoveryId.trim()}>{busy ? "Requesting…" : "Request reset link"}</Button></form></DialogContent></Dialog>
    </div>
  )
}
