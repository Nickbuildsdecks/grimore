import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface WorkspaceStateProps {
  icon: ReactNode
  title: string
  description: string
  actions?: ReactNode
  aside?: ReactNode
  className?: string
}

export function WorkspaceState({ icon, title, description, actions, aside, className }: WorkspaceStateProps) {
  return (
    <section className={cn("workspace-state", aside && "workspace-state-with-aside", className)}>
      <div className="workspace-state-copy">
        <span className="workspace-state-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {actions && <div className="workspace-state-actions">{actions}</div>}
      </div>
      {aside && <div className="workspace-state-aside">{aside}</div>}
    </section>
  )
}
