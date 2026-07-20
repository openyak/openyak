import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[var(--brand-primary)] text-[var(--brand-primary-text)]",
        secondary:
          "border-transparent bg-[var(--surface-tertiary)] text-[var(--text-secondary)]",
        outline:
          "border-[var(--border-default)] text-[var(--text-secondary)]",
        success:
          "border-transparent bg-[var(--color-success)] text-white",
        warning:
          "border-transparent bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
        destructive:
          "border-transparent bg-[var(--color-destructive)] text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
