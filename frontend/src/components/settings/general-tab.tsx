"use client";

import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Separator } from "@/components/ui/separator";

export function GeneralTab() {
  const { t, i18n } = useTranslation('settings');
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-8">
      {/* Theme Section */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('appearance')}
        </h2>
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: "light", label: t('light'), icon: Sun },
            { value: "dark", label: t('dark'), icon: Moon },
            { value: "system", label: t('system'), icon: Monitor },
          ].map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                theme === value
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                  : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-xs font-medium">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* Language Section */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('language')}
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {[
            { value: "en", label: "English" },
            { value: "zh", label: "中文" },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => {
                i18n.changeLanguage(value);
                localStorage.setItem("openyak-language", value);
              }}
              className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                i18n.language.startsWith(value)
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                  : "border-[var(--border-default)] hover:bg-[var(--surface-secondary)]"
              }`}
            >
              <span className="text-xs font-medium">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* About */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          {t('about')}
        </h2>
        <div className="text-xs text-[var(--text-secondary)] space-y-1">
          <p>{t('aboutVersion')}</p>
          <p>{t('aboutDesc')}</p>
          <p>{t('aboutCopyright')}</p>
        </div>
      </section>
    </div>
  );
}
