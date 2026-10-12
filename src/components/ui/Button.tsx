import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

type Variant = 'default' | 'primary' | 'ghost' | 'danger';
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; busy?: boolean; size?: 'md' | 'sm' }

export function Button({ variant = 'default', busy, size = 'md', className, type = 'button', ...rest }: Props) {
  const cls = [styles[variant], size === 'sm' && styles.sm, busy && styles.busy, className].filter(Boolean).join(' ');
  return <button type={type} className={cls || undefined} data-variant={variant} aria-busy={busy || undefined} {...rest} />;
}
