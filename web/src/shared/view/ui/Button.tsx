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
          'rounded-xl border border-black/5 bg-gradient-to-b from-white to-slate-100 text-slate-900 transition-all',
          'shadow-[0_4px_0_#d8d5df,0_10px_20px_rgba(35,33,41,0.08)]',
          'hover:-translate-y-0.5 hover:shadow-[0_6px_0_#d8d5df,0_14px_26px_rgba(35,33,41,0.12)]',
          'active:translate-y-[3px] active:shadow-[0_1px_0_#d8d5df,0_3px_8px_rgba(35,33,41,0.08)]',
          'dark:border-white/10 dark:from-zinc-800 dark:to-zinc-900 dark:text-zinc-100',
          'dark:shadow-[0_4px_0_#1f1f26,0_10px_20px_rgba(0,0,0,0.45)]',
          'dark:hover:shadow-[0_6px_0_#1f1f26,0_14px_26px_rgba(0,0,0,0.5)]',
          'dark:active:shadow-[0_1px_0_#1f1f26,0_3px_8px_rgba(0,0,0,0.4)]',
        ].join(' '),
        // W4 立体厚板 —— 主色(新建任务 / 终端激活态)
        chunkyPrimary: [
          'rounded-xl border border-transparent bg-gradient-to-b from-[#5b8cff] to-[#2f5fe0] text-white transition-all',
          'shadow-[0_4px_0_#1c3fa8,0_12px_24px_rgba(47,95,224,0.28)]',
          'hover:-translate-y-0.5 hover:shadow-[0_6px_0_#1c3fa8,0_16px_30px_rgba(47,95,224,0.4)]',
          'active:translate-y-[3px] active:shadow-[0_1px_0_#1c3fa8,0_3px_8px_rgba(47,95,224,0.25)]',
          'dark:from-[#7ea6ff] dark:to-[#4d7df0]',
          'dark:shadow-[0_4px_0_#1a2d5c,0_12px_24px_rgba(90,130,255,0.35)]',
          'dark:hover:shadow-[0_6px_0_#1a2d5c,0_16px_30px_rgba(90,130,255,0.45)]',
          'dark:active:shadow-[0_1px_0_#1a2d5c,0_3px_8px_rgba(90,130,255,0.3)]',
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
