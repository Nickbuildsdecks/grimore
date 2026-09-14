import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface PageHeaderProps {
  title: string
  description: string
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("page-header", className)}>
      <div className="page-header-copy min-w-0">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  )
}
