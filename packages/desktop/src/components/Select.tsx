// Shared dropdown select built on @radix-ui/react-select (headless behavior:
// keyboard nav, typeahead, focus management, collision-aware positioning).
// Visuals come from the .rsel-* classes in global.css (Geist dark palette).
import * as SelectPrimitive from '@radix-ui/react-select';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectProps = {
  /** Current selection; null/'' shows the placeholder (not selectable). */
  value: string | null;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** ghost = borderless (sidebar project box); bordered = form/filter style. */
  variant?: 'ghost' | 'bordered';
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
};

export function Select({
  value,
  options,
  onChange,
  variant = 'bordered',
  ariaLabel,
  placeholder,
  disabled,
}: SelectProps) {
  const triggerCls = variant === 'ghost' ? 'rsel-trigger ghost' : 'rsel-trigger';
  return (
    <SelectPrimitive.Root
      value={value ?? undefined}
      onValueChange={onChange}
      disabled={disabled || options.length === 0}
    >
      <SelectPrimitive.Trigger className={triggerCls} aria-label={ariaLabel}>
        <SelectPrimitive.Value className="rsel-value" placeholder={placeholder} />
        <SelectPrimitive.Icon className="rsel-icon">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="rsel-content">
          <SelectPrimitive.Viewport className="rsel-viewport">
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className="rsel-item"
              >
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="rsel-ind">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M3 8.5l3.5 3.5L13 4.5" />
                  </svg>
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
