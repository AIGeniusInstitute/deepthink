import { useEffect, useState } from 'react';
import { Loader2, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { SettingsCard } from './SettingsCard';
import { getErrorMessage } from './types';
import {
  SUPPORTED_LANGUAGES,
  isRtlLanguage,
} from '../../i18n/languages';
import { APP_I18N } from '../../i18n/config';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function LanguageSection() {
  const { t } = useTranslation();
  const { user, updateProfile } = useAuthStore();
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState<string>(user?.language || 'zh-CN');

  useEffect(() => {
    if (user?.language && user.language !== current) {
      setCurrent(user.language);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.language]);

  const handleChange = async (code: string) => {
    if (code === current) return;
    setSaving(true);
    const previous = current;
    setCurrent(code);
    // Optimistic: switch UI immediately so user sees the change in real time.
    try {
      await APP_I18N.changeLanguage(code);
      await updateProfile({ language: code });
      const meta = SUPPORTED_LANGUAGES.find((l) => l.code === code);
      const notice = isRtlLanguage(code)
        ? t('settings.language.rtlNotice')
        : t('settings.language.appliedNotice');
      toast.success(`${notice} · ${meta?.native ?? code}`);
    } catch (err) {
      // Rollback
      setCurrent(previous);
      await APP_I18N.changeLanguage(previous);
      toast.error(getErrorMessage(err, t('errors.networkFailure')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={Globe}
        title={t('settings.language.title')}
        desc={t('settings.language.description')}
      >
        <div className="flex items-center gap-3">
          <Select value={current} onValueChange={handleChange} disabled={saving}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('settings.language.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LANGUAGES.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  <span className="flex items-center justify-between w-full">
                    <span>{lang.native}</span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {lang.name} · {lang.code}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {saving && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />}
        </div>
      </SettingsCard>
    </div>
  );
}
