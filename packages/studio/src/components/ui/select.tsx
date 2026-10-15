import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label?: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options: SelectOption[];
  /** Controlled value. Empty string selects the placeholder. */
  value?: string;
  /** `null` is reported when the placeholder option is picked. */
  onValueChange?: (value: string | null) => void;
  /** Displayed when no option is selected. */
  placeholder?: string;
  /** Adds a disabled entry with this label at the top. */
  emptyLabel?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, onValueChange, placeholder = 'Selecciona una opción', emptyLabel = '—', ...props },
  ref,
) {
  return (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        onChange={(event) => onValueChange?.(event.target.value === '' ? null : event.target.value)}
        className={cn(
          'h-9 w-full appearance-none rounded-md border border-input bg-background py-1 pl-3 pr-8 text-sm shadow-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        {...props}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label ?? option.value}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
});