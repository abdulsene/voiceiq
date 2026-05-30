// /src/components/IndustriesMegaMenu.tsx
// Position C megamenu: spotlighted (deep playbooks) + catalog (193+) hierarchy.

import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "./ui/navigation-menu";
import { CATEGORY_ORDER, type IndustryBrief } from "../data/featured-industries";
import {
  useTranslatedIndustries,
  useTranslatedFeaturedIndustries,
  useTranslatedIndustriesByCategory,
} from "../hooks/useTranslatedIndustries";

function FeaturedTile({ brief }: { brief: IndustryBrief }) {
  return (
    <Link
      href={`/for/${brief.slug}`}
      className="group flex items-start gap-3 p-3 bg-gradient-to-br from-indigo-50 to-blue-50 hover:from-indigo-100 hover:to-blue-100 border border-indigo-100 rounded-lg transition-all"
    >
      <span className="text-2xl flex-shrink-0 mt-0.5" aria-hidden="true">
        {brief.emoji}
      </span>
      <div className="min-w-0">
        <div className="font-bold text-slate-900 group-hover:text-indigo-600 transition-colors text-sm">
          {brief.name}
        </div>
        <div className="text-xs text-slate-600 leading-snug mt-0.5 line-clamp-2">
          {brief.shortPitch}
        </div>
      </div>
    </Link>
  );
}

function CompactLink({ brief }: { brief: IndustryBrief }) {
  return (
    <Link
      href={`/for/${brief.slug}`}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-100 transition-colors group"
    >
      <span className="text-base flex-shrink-0" aria-hidden="true">{brief.emoji}</span>
      <span className="text-sm text-slate-700 group-hover:text-indigo-600 transition-colors truncate">
        {brief.name}
      </span>
    </Link>
  );
}

function CategoryColumn({ cat }: { cat: (typeof CATEGORY_ORDER)[number] }) {
  const { t } = useTranslation();
  const items = useTranslatedIndustriesByCategory(cat);
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 px-2">
        {t(`marketing.categories.${cat}`)}
      </h3>
      <div className="space-y-0.5">
        {items.map((brief) => (
          <CompactLink key={brief.slug} brief={brief} />
        ))}
      </div>
    </div>
  );
}

export function IndustriesMegaMenu() {
  const { t } = useTranslation();
  const all = useTranslatedIndustries();
  const featured = useTranslatedFeaturedIndustries().slice(0, 4);

  return (
    <NavigationMenu>
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger className="bg-transparent text-slate-700 hover:text-slate-900 px-0 h-auto font-medium">
            {t("marketing.megamenu.trigger")}
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <div className="w-[760px] p-6 bg-white">
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1L8.5 5L13 5.5L9.5 8.5L10.5 13L7 10.5L3.5 13L4.5 8.5L1 5.5L5.5 5L7 1Z"
                          fill="#6366F1"/>
                  </svg>
                  <span className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                    {t("marketing.megamenu.spotlightedToday")}
                  </span>
                  <span className="text-xs text-slate-500">{t("marketing.megamenu.deepPlaybooks", { count: all.length })}</span>
                </div>
                <Link
                  href="/industries"
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                >
                  {t("marketing.megamenu.seeAllSpotlighted")}
                </Link>
              </div>

              <div className="grid grid-cols-4 gap-3 mb-5">
                {featured.map((b) => (
                  <FeaturedTile key={b.slug} brief={b} />
                ))}
              </div>

              <div className="grid grid-cols-3 gap-x-6 gap-y-4 pt-4 border-t border-slate-100">
                {CATEGORY_ORDER.map((cat) => (
                  <CategoryColumn key={cat} cat={cat} />
                ))}
              </div>

              <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between bg-slate-50 -mx-6 -mb-6 px-6 py-4 rounded-b-md">
                <div className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <rect x="1" y="1" width="5" height="5" rx="1" fill="#64748B"/>
                    <rect x="8" y="1" width="5" height="5" rx="1" fill="#64748B"/>
                    <rect x="1" y="8" width="5" height="5" rx="1" fill="#64748B"/>
                    <rect x="8" y="8" width="5" height="5" rx="1" fill="#64748B"/>
                  </svg>
                  <span className="text-xs text-slate-600">
                    {t("marketing.megamenu.catalogPrefix")} <strong className="text-slate-900">{t("marketing.megamenu.catalogStrong")}</strong> {t("marketing.megamenu.catalogSuffix")}
                  </span>
                </div>
                <Link
                  href="/industries"
                  className="text-xs font-semibold text-slate-700 hover:text-slate-900 inline-flex items-center gap-1"
                >
                  {t("marketing.megamenu.browseCatalog")}
                </Link>
              </div>
            </div>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
