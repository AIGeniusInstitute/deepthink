import { useEffect, useMemo, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useBillingStore } from '../../stores/billing';
import { useScrollDirection } from '../../hooks/useScrollDirection';
import { lightTap } from '../../hooks/useHaptic';
import { filterNavItems } from './nav-items';

export function BottomTabBar() {
  const location = useLocation();
  const scrollDir = useScrollDirection();
  const isCompact = scrollDir === 'down';
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const navRef = useRef<HTMLElement>(null);

  const navItems = useMemo(
    () => filterNavItems(billingEnabled),
    [billingEnabled],
  );

  // 窄屏下菜单可横向滚动：把当前激活项滚进视口中央，保证定位可见
  useEffect(() => {
    const el = navRef.current?.querySelector('.floating-nav-item.active');
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [location.pathname, navItems.length]);

  return (
    <>
      <div className="pwa-bottom-guard" aria-hidden="true" />
      <div className={`floating-nav-container ${isCompact ? 'compact' : ''}`}>
        <nav className="floating-nav" ref={navRef}>
          {navItems.map(({ path, icon: Icon, label }) => {
            const isActive = location.pathname.startsWith(path);
            return (
              <NavLink
                key={path}
                to={path}
                replace
                className={`floating-nav-item flex-col items-center justify-center ${isActive ? 'active' : ''}`}
                aria-label={label}
                onClick={() => lightTap()}
              >
                <Icon className="w-5 h-5" />
                <span className={`text-[10px] leading-tight mt-0.5 transition-all duration-200 ${isActive ? 'text-primary' : ''} ${isCompact ? 'max-h-0 opacity-0 overflow-hidden' : 'max-h-4 opacity-100'}`}>{label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>
    </>
  );
}
