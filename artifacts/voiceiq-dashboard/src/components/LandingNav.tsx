import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { Menu, ChevronDown } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "./ui/sheet";
import { IndustriesMegaMenu } from "./IndustriesMegaMenu";
import { CATEGORY_ORDER } from "../data/featured-industries";
import { useTranslatedIndustriesByCategory } from "../hooks/useTranslatedIndustries";
import LanguageSwitcher from "./LanguageSwitcher";

function MobileCategoryGroup({
  cat,
  onItemClick,
}: {
  cat: (typeof CATEGORY_ORDER)[number];
  onItemClick: () => void;
}) {
  const { t } = useTranslation();
  const items = useTranslatedIndustriesByCategory(cat);
  if (items.length === 0) return null;
  return (
    <div>
      <div className="px-4 pt-2 text-xs font-bold uppercase tracking-wider text-slate-400">
        {t(`marketing.categories.${cat}`)}
      </div>
      {items.map((brief) => (
        <Link
          key={brief.slug}
          href={`/for/${brief.slug}`}
          onClick={onItemClick}
          className="px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded flex items-center gap-2"
        >
          <span>{brief.emoji}</span>
          <span>{brief.name}</span>
        </Link>
      ))}
    </div>
  );
}

export default function LandingNav() {
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileIndustriesOpen, setMobileIndustriesOpen] = useState(false);
  const [isShrunk, setIsShrunk] = useState(false);

  useEffect(() => {
    const sentinel = document.querySelector("[data-hero-sentinel]");
    if (!sentinel) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsShrunk(!entry.isIntersecting);
      },
      { rootMargin: "-80px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 bg-white/80 border-b border-slate-200/60 transition-all duration-200 ease-out ${
        isShrunk ? "backdrop-blur-lg shadow-sm" : "backdrop-blur-md"
      }`}
    >
      <div
        className={`max-w-7xl mx-auto px-6 flex items-center justify-between transition-all duration-200 ease-out ${
          isShrunk ? "py-3" : "py-5"
        }`}
      >
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <img
            src={`${import.meta.env.BASE_URL}neverr-logo.png`}
            alt="Neverr — AI Receptionist"
            className={`w-auto transition-all duration-200 ease-out ${
              isShrunk ? "h-9 md:h-10" : "h-9 md:h-16"
            }`}
          />
        </Link>

        <div className="hidden md:flex items-center gap-8">
          <nav className="flex items-center gap-6 text-sm text-slate-600">
            <Link href="/" className="hover:text-slate-900">
              {t("marketing.nav.home")}
            </Link>
            <Link href="/features" className="hover:text-slate-900">
              {t("marketing.nav.features")}
            </Link>
            <IndustriesMegaMenu />
            <Link href="/pricing" className="hover:text-slate-900">
              {t("marketing.nav.pricing")}
            </Link>
            <Link href="/enterprise" className="hover:text-slate-900">
              {t("marketing.nav.enterprise")}
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <LanguageSwitcher variant="light" />
            <Link
              href="/login"
              className="text-sm text-slate-600 hover:text-slate-900 whitespace-nowrap"
            >
              {t("marketing.nav.login")}
            </Link>
            <Link
              href="/signup"
              className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              {t("marketing.nav.getStarted")} <span className="text-xs">→</span>
            </Link>
          </div>
        </div>

        <div className="md:hidden flex items-center gap-2">
          <LanguageSwitcher variant="light" />
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label={t("marketing.nav.openMenu")}
                className="p-2 -mr-2 text-slate-700 hover:text-slate-900"
              >
                <Menu className="h-6 w-6" />
              </button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-[280px] sm:w-[320px] bg-white overflow-y-auto"
            >
              <nav className="flex flex-col gap-1 mt-8">
                <Link
                  href="/"
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-3 text-base text-slate-700 hover:bg-slate-50 rounded"
                >
                  {t("marketing.nav.home")}
                </Link>
                <Link
                  href="/features"
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-3 text-base text-slate-700 hover:bg-slate-50 rounded"
                >
                  {t("marketing.nav.features")}
                </Link>

                <button
                  type="button"
                  onClick={() => setMobileIndustriesOpen((v) => !v)}
                  className="px-4 py-3 text-base text-slate-700 hover:bg-slate-50 rounded text-left flex items-center justify-between"
                  aria-expanded={mobileIndustriesOpen}
                >
                  <span>{t("marketing.nav.industries")}</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      mobileIndustriesOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {mobileIndustriesOpen && (
                  <div className="pl-2 pb-2 space-y-3">
                    {CATEGORY_ORDER.map((cat) => (
                      <MobileCategoryGroup
                        key={cat}
                        cat={cat}
                        onItemClick={() => {
                          setMobileOpen(false);
                          setMobileIndustriesOpen(false);
                        }}
                      />
                    ))}
                    <Link
                      href="/industries"
                      onClick={() => setMobileOpen(false)}
                      className="px-4 py-2 text-sm font-semibold text-blue-600 hover:bg-slate-50 rounded block"
                    >
                      {t("marketing.nav.viewAllIndustries")}
                    </Link>
                  </div>
                )}

                <Link
                  href="/pricing"
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-3 text-base text-slate-700 hover:bg-slate-50 rounded"
                >
                  {t("marketing.nav.pricing")}
                </Link>
                <Link
                  href="/enterprise"
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-3 text-base text-slate-700 hover:bg-slate-50 rounded"
                >
                  {t("marketing.nav.enterprise")}
                </Link>

                <div className="border-t border-slate-200 my-4" />
                <a
                  href="tel:+19789638377"
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-3 text-base text-slate-700 hover:bg-slate-50 rounded flex items-center gap-2"
                >
                  <span>📞</span>
                  <span>{t("marketing.nav.phoneLabel")}</span>
                </a>
                <Link
                  href="/login"
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-3 text-base text-slate-700 hover:bg-slate-50 rounded"
                >
                  {t("marketing.nav.login")}
                </Link>
                <Link
                  href="/signup"
                  onClick={() => setMobileOpen(false)}
                  className="px-4 py-3 mx-2 text-base text-center font-semibold bg-slate-900 text-white rounded hover:bg-slate-800"
                >
                  {t("marketing.nav.getStarted")} →
                </Link>
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
