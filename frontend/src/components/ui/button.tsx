import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] text-sm font-medium transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-35 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Text colors use the explicit `color:` hint — a bare var() in
        // text-[...] is ambiguous to tailwind-merge and can be dropped as a
        // font-size conflict.
        default:
          "bg-[var(--ink-solid)] text-[color:var(--ink-solid-text)] hover:bg-[var(--ink-solid-hover)] shadow-[var(--shadow-sm)]",
        brand:
          "bg-[var(--brand-primary)] text-[color:var(--brand-primary-text)] hover:bg-[var(--brand-primary-hover)] shadow-[var(--shadow-sm)]",
        destructive:
          "bg-[var(--color-destructive)] text-white hover:opacity-90",
        outline:
          "border border-[var(--border-default)] bg-transparent hover:bg-[var(--surface-secondary)] text-[color:var(--text-primary)]",
        secondary:
          "bg-[var(--surface-secondary)] text-[color:var(--text-primary)] hover:bg-[var(--surface-tertiary)]",
        ghost:
          "hover:bg-[var(--surface-secondary)] text-[color:var(--text-primary)]",
        link: "text-[color:var(--brand-primary)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-ui-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
