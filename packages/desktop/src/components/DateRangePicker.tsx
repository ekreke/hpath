// Date range picker for the history filters (Geist dark style, matches the
// .rsel-* select family). Built on @radix-ui/react-popover for focus trapping,
// Esc-to-close and collision-aware positioning; the calendar itself is a plain
// 7-column grid of buttons.
//
// Values are local "yyyy-mm-dd" strings ('' = unset) — the same shape the
// HistoryView stores in its Filters, so query-side conversion is untouched.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as PopoverPrimitive from '@radix-ui/react-popover';

export type DateRange = { from: string; to: string };

type DateRangePickerProps = {
  from: string;
  to: string;
  onChange: (range: DateRange) => void;
  ariaLabel?: string;
};

const GRID_DAYS = 42; // 6 weeks — covers every month/week-start combination

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

function todayYmd(): string {
  return toYmd(new Date());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// Monday-first for zh, Sunday-first otherwise (i18next resolved language).
function weekStartsOn(lang: string): 0 | 1 {
  return lang.toLowerCase().startsWith('zh') ? 1 : 0;
}

export function DateRangePicker({ from, to, onChange, ariaLabel }: DateRangePickerProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? 'en';
  const [open, setOpen] = useState(false);
  // First day of the month shown in the grid; null while closed.
  const [viewMonth, setViewMonth] = useState<Date | null>(null);
  // While picking: from is set, to is not — the next day click completes the
  // range (or restarts it if clicked before `from`).
  const pickingEnd = Boolean(from) && !to;
  const [hoverYmd, setHoverYmd] = useState<string | null>(null);

  const openAt = (ymd: string | null) => {
    const base = ymd ? parseYmd(ymd) : new Date();
    setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1));
    setHoverYmd(null);
    setOpen(true);
  };

  const pickDay = (ymd: string) => {
    if (!from || to) {
      onChange({ from: ymd, to: '' });
      return;
    }
    if (ymd < from) {
      onChange({ from: ymd, to: '' });
      return;
    }
    onChange({ from, to: ymd });
    setOpen(false);
  };

  const applyPreset = (start: Date, end: Date) => {
    onChange({ from: toYmd(start), to: toYmd(end) });
    setOpen(false);
  };

  const clear = () => {
    onChange({ from: '', to: '' });
    setHoverYmd(null);
  };

  // Calendar labels + grid are rebuilt only when the month or locale changes.
  const grid = useMemo(() => {
    if (!viewMonth) return null;
    const ws = weekStartsOn(lang);
    const wdFmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow' });
    // Anchor week 2024-01-07 is a Sunday; walk from it so labels follow ws.
    const weekdays = Array.from({ length: 7 }, (_, i) =>
      wdFmt.format(new Date(2024, 0, 7 + ((ws + i) % 7))),
    );
    const firstDow = viewMonth.getDay();
    const offset = ws === 1 ? (firstDow === 0 ? 6 : firstDow - 1) : firstDow;
    const gridStart = addDays(viewMonth, -offset);
    const monthFmt = new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long' });
    const days = Array.from({ length: GRID_DAYS }, (_, i) => addDays(gridStart, i));
    return { weekdays, days, title: monthFmt.format(viewMonth) };
  }, [viewMonth, lang]);

  const today = todayYmd();
  // Effective range end while hovering during end-picking (preview).
  const rangeEnd = to || (pickingEnd && hoverYmd && hoverYmd >= from ? hoverYmd : '');
  const rangeStart = from;

  const shiftMonth = (delta: number) => {
    if (!viewMonth) return;
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1));
  };

  const display = from && to ? `${from.replace(/-/g, '/')} – ${to.replace(/-/g, '/')}` : '';

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) openAt(from || null);
        else setOpen(false);
      }}
    >
      <PopoverPrimitive.Trigger className="drp-trigger" aria-label={ariaLabel} data-empty={!display ? '' : undefined}>
        <svg className="drp-cal" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2" y="3.5" width="12" height="10.5" rx="1.5" />
          <path d="M2 6.5h12M5.5 1.8v3M10.5 1.8v3" />
        </svg>
        <span className="drp-value">{display || t('history.allDates')}</span>
        {display && (
          <button
            type="button"
            className="drp-clear"
            aria-label={t('history.clear')}
            onClick={(e) => {
              // Keep the popover trigger from toggling when only clearing.
              e.stopPropagation();
              e.preventDefault();
              clear();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        )}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={4}
          align="start"
          className="drp-content"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="drp-presets">
            <button type="button" className="drp-preset" onClick={() => applyPreset(addDays(new Date(), -6), new Date())}>
              {t('history.presets7')}
            </button>
            <button type="button" className="drp-preset" onClick={() => applyPreset(addDays(new Date(), -29), new Date())}>
              {t('history.presets30')}
            </button>
            <button type="button" className="drp-preset" onClick={() => applyPreset(new Date(new Date().getFullYear(), new Date().getMonth(), 1), new Date())}>
              {t('history.presetsMonth')}
            </button>
          </div>

          <div className="drp-head">
            <button type="button" className="drp-nav" aria-label={t('history.prevMonth')} onClick={() => shiftMonth(-1)}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M10 3.5L5.5 8l4.5 4.5" />
              </svg>
            </button>
            <span className="drp-month">{grid?.title}</span>
            <button type="button" className="drp-nav" aria-label={t('history.nextMonth')} onClick={() => shiftMonth(1)}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M6 3.5L10.5 8 6 12.5" />
              </svg>
            </button>
          </div>

          <div className="drp-grid" onMouseLeave={() => setHoverYmd(null)}>
            {grid?.weekdays.map((wd) => (
              <span key={wd} className="drp-wd">{wd}</span>
            ))}
            {grid?.days.map((d) => {
              const ymd = toYmd(d);
              const out = d.getMonth() !== viewMonth!.getMonth();
              const isEdge = ymd === rangeStart || ymd === rangeEnd;
              const isInRange = Boolean(rangeStart && rangeEnd && ymd > rangeStart && ymd < rangeEnd);
              return (
                <button
                  key={ymd}
                  type="button"
                  className={
                    'drp-day' +
                    (out ? ' out' : '') +
                    (isEdge ? ' edge' : '') +
                    (isInRange ? ' inrange' : '') +
                    (ymd === today ? ' today' : '')
                  }
                  onMouseEnter={() => setHoverYmd(ymd)}
                  onClick={() => pickDay(ymd)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div className="drp-foot">
            <button type="button" className="drp-preset" onClick={clear} disabled={!from && !to}>
              {t('history.clear')}
            </button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
