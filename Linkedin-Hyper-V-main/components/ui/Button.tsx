import React from 'react';
import { cn } from '@/lib/utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  children: React.ReactNode;
}

const variants = {
  primary: 'app-button-primary',
  secondary: 'app-button-secondary',
  ghost: 'app-button-ghost',
  danger: 'app-button-danger',
};

const sizes = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-sm',
  icon: 'h-10 w-10 p-0',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn('app-button disabled:opacity-50', variants[variant], sizes[size], className)}
      {...props}
    >
      {children}
    </button>
  )
);

Button.displayName = 'Button';
