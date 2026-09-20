import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

// Keep visual variants centralized so all button usages stay consistent.
const buttonVariants = cva(
  'inline-flex touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90 active:bg-primary/80',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:bg-destructive/80',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 active:bg-secondary/70',
        ghost: 'hover:bg-accent hover:text-accent-foreground active:bg-accent/80',
        link: 'text-primary underline-offset-4 hover:underline',
        // W4 立体厚板 —— 白卡(次要)
        chunky: [
          'rounded-xl border border-border bg-gradient-to-b from-card to-muted text-foreground transition-all',
          'shadow-[0_4px_0_hsl(var(--border)),0_10px_20px_hsl(var(--foreground)/0.08)]',
          'hover:-translate-y-0.5 hover:shadow-[0_6px_0_hsl(var(--border)),0_14px_26px_hsl(var(--foreground)/0.12)]',
          'active:translate-y-[3px] active:shadow-[0_1px_0_hsl(var(--border)),0_3px_8px_hsl(var(--foreground)/0.08)]',
        ].join(' '),
        // W4 立体厚板 —— 主色(新建任务 / 终端激活态)
        chunkyPrimary: [
          'rounded-xl border border-transparent bg-gradient-to-b from-primary/90 to-primary text-primary-foreground transition-all',
          'shadow-[0_4px_0_hsl(var(--primary)),0_12px_24px_hsl(var(--primary)/0.28)]',
          'hover:-translate-y-0.5 hover:shadow-[0_6px_0_hsl(var(--primary)),0_16px_30px_hsl(var(--primary)/0.4)]',
          'active:translate-y-[3px] active:shadow-[0_1px_0_hsl(var(--primary)),0_3px_8px_hsl(var(--primary)/0.25)]',
        ].join(' '),
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3 text-sm',
        lg: 'h-11 px-8',
        icon: 'h-10 w-10',
        // W4 工具栏统一尺寸:34px 高,圆角由 variant 提供
        toolbar: 'h-[34px] px-3.5 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);

Button.displayName = 'Button';

export { Button, buttonVariants };
