import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] border border-transparent text-sm font-semibold leading-none whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 outline-none active:scale-[0.98] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:scale-100 disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/16%)] hover:bg-primary/90 active:bg-primary/82",
        destructive:
          "bg-destructive text-white hover:bg-destructive/88 focus-visible:ring-destructive/20 dark:bg-destructive/65 dark:focus-visible:ring-destructive/40",
        outline:
          "border-input bg-background/24 text-foreground hover:border-primary/45 hover:bg-primary/8 hover:text-foreground",
        secondary:
          "border-border bg-secondary/72 text-secondary-foreground hover:border-primary/30 hover:bg-secondary",
        ghost:
          "text-muted-foreground hover:bg-secondary/58 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 max-md:h-11 has-[>svg]:px-3",
        xs: "h-7 gap-1 rounded-[8px] px-2 text-xs max-md:h-11 max-md:px-3 has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 gap-1.5 px-3 max-md:h-11 has-[>svg]:px-2.5",
        lg: "h-11 px-5 text-[0.95rem] max-md:h-12 has-[>svg]:px-4",
        icon: "size-10 max-md:size-11",
        "icon-xs": "size-7 rounded-[8px] max-md:size-11 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9 rounded-[9px] max-md:size-11",
        "icon-lg": "size-12 rounded-[12px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
