/**
 * Table talk, as a drawer.
 *
 * Its own component because it is drawn on **two** screens with the same rules: a player's table
 * and a watcher's. It used to be inline in the player's and absent from the watcher's, which is
 * how a spectator came to be able to talk — the server has always accepted it — with nowhere to
 * type and no label if they had.
 */
import { useState } from "react"
import { Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ChatLine } from "@/lib/table"

export interface ChatPanelProps {
  lines: readonly ChatLine[]
  /** Sends the line. The panel clears the box whatever happens, as a chat box does. */
  onSend: (text: string) => void
  onClose: () => void
}

export function ChatPanel({ lines, onSend, onClose }: ChatPanelProps) {
  const [draft, setDraft] = useState("")

  return (
    <div data-testid="chat-panel" className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div className="flex w-full max-w-sm flex-col border-l border-white/15 bg-[var(--g-surface-2)]" onClick={(e) => e.stopPropagation()}>
        <h2 className="border-b border-white/10 p-4 text-sm font-semibold text-[var(--g-text-high)]">
          Table talk
        </h2>
        <div data-testid="chat-messages" className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
          {lines.length === 0 ? (
            <p className="text-xs text-[var(--g-text-muted)]">
              Nothing said yet. This is for the things the table cannot decide for you — whether
              you are responding, what a trigger did, taking something back.
            </p>
          ) : (
            lines.map((line) => (
              <p key={line.id} className="text-xs text-[var(--g-text-high)]">
                <span className="font-semibold text-[var(--g-gold-400)]">{line.name}</span>
                {/*
                  Said once, beside the name, for a line from somebody who is not playing. Without
                  it a spectator's "I'm responding to that" reads like an opponent's, and a player
                  can act on it in good faith and be wrong. The flag is the server's: see
                  `ChatLine.watching`.
                */}
                {line.watching === true ? (
                  <span
                    data-testid={`chat-watching-${line.id}`}
                    className="ml-1 rounded bg-white/10 px-1 text-[9px] uppercase tracking-wide text-[var(--g-text-muted)]"
                  >
                    watching
                  </span>
                ) : null}{" "}
                {line.text}
              </p>
            ))
          )}
        </div>
        <form
          className="flex gap-1.5 border-t border-white/10 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            onSend(draft)
            setDraft("")
          }}
        >
          <Input
            data-testid="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Say something"
            maxLength={400}
          />
          <Button type="submit" size="icon" data-testid="chat-send" aria-label="Send">
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  )
}
