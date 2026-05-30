import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Users, Link2, DollarSign, CheckCircle, Send, ArrowLeft, Briefcase, Globe, UserCheck, TrendingUp } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const PARTNER_TYPES = [
  "Agency / Marketing",
  "Consultant",
  "Tech / SaaS Partner",
  "Franchise Consultant",
  "Individual",
];

const REFERRAL_VOLUMES = ["1–2", "3–5", "6–10", "10+"];

function PartnerForm() {
  const [form, setForm] = useState({
    name: "",
    company: "",
    email: "",
    phone: "",
    partnerType: "",
    referrals: "",
    network: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.company || !form.email) return;
    setSubmitting(true);
    try {
      await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          business_name: form.company,
          email: form.email,
          phone: form.phone,
          industry: form.partnerType,
          call_volume: form.referrals,
          message: `[PARTNER APPLICATION] Type: ${form.partnerType} | Referrals: ${form.referrals}/mo | Network: ${form.network}`,
        }),
      });
      setSubmitted(true);
    } catch {
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="text-center py-12">
        <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="w-8 h-8 text-emerald-600" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Application received!</h3>
        <p className="text-gray-600">We'll reach out within 24 hours.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6]"
            placeholder="Jane Smith"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Company *</label>
          <input
            type="text"
            required
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
            className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6]"
            placeholder="Acme Marketing"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6]"
            placeholder="jane@acme.com"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6]"
            placeholder="(555) 123-4567"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Partner Type</label>
          <select
            value={form.partnerType}
            onChange={(e) => setForm({ ...form, partnerType: e.target.value })}
            className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] bg-white"
          >
            <option value="">Select type...</option>
            {PARTNER_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Expected Monthly Referrals</label>
          <select
            value={form.referrals}
            onChange={(e) => setForm({ ...form, referrals: e.target.value })}
            className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] bg-white"
          >
            <option value="">Select volume...</option>
            {REFERRAL_VOLUMES.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Tell us about your network</label>
        <textarea
          value={form.network}
          onChange={(e) => setForm({ ...form, network: e.target.value })}
          rows={4}
          className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] resize-none"
          placeholder="What industries do you serve? How many businesses are in your network?"
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-[#2E75B6] text-white font-semibold rounded-xl hover:bg-[#2563a0] transition-colors shadow-sm disabled:opacity-60"
      >
        {submitting ? "Submitting..." : "Apply Now"}
        {!submitting && <ArrowRight className="w-4 h-4" />}
      </button>
    </form>
  );
}

export default function Partner() {
  return (
    <div className="min-h-screen bg-white">
      {/* Sprint 2 STEP 2 (BUG-13): replaced the Partner-specific fixed nav
          (logo + "Back to home" link only — was missing all marketing nav
          links) with the standard public LandingNav. The next section's
          pt-32 was a manual offset for the previous fixed (out-of-flow)
          nav; LandingNav is sticky and takes its own flow space, so this
          drops to pt-16 to avoid an oversized gap below the nav. */}
      <LandingNav />

      <section className="pt-16 pb-20 px-6 bg-gradient-to-b from-[#f8fafc] to-white">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-emerald-50 rounded-full text-sm text-emerald-700 font-medium mb-6">
            <Users className="w-4 h-4" />
            Partner Program
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold text-[#1B2537] leading-tight mb-5">
            Earn recurring income with{" "}
            <span className="text-[#2E75B6]">Neverr</span>
          </h1>
          {/* Sprint 2 STEP 3 (BUG-16): hero copy de-committed. The previous
              line specified "up to 15% of their monthly subscription" — a
              public number Abdul hadn't ratified. Replaced with directional
              copy that still sells the program without making a contractual
              commitment. Specific rates are negotiated at partner approval. */}
          <p className="text-lg text-gray-600 leading-relaxed max-w-2xl mx-auto mb-8">
            Refer businesses to Neverr and earn recurring monthly commissions on every active subscription — every month, for as long as your referrals stay.
          </p>
          <button
            onClick={() => document.getElementById("partner-form")?.scrollIntoView({ behavior: "smooth" })}
            className="inline-flex items-center gap-2 px-8 py-3.5 bg-[#2E75B6] text-white font-semibold rounded-xl hover:bg-[#2563a0] transition-colors shadow-lg shadow-[#2E75B6]/20"
          >
            Apply to become a partner
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* Sprint 2 STEP 3 (BUG-16): replaced the previous "Commission
          Structure" table (Setup 15% / Months 1-12 = 15% / 13-24 = 10% /
          25+ = 5%) and the "$1,123.50/month" example callout with
          directional copy. Those specific numbers were a unilateral
          public commitment that Abdul hadn't ratified; partners now see
          the shape of the program (recurring, tiered, with co-marketing)
          without seeing exact rates. Final rates land in the partner
          agreement at approval time. Icons match the page convention
          (lucide-react in a [#2E75B6]/10 rounded-xl badge container). */}
      <section className="py-16 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-[#1B2537] text-center mb-4">How partners earn</h2>
          <p className="text-center text-gray-500 max-w-2xl mx-auto mb-12">
            We share recurring revenue with our partners — paid every month, for as long as your referrals stay subscribed. Approved partners receive a personalized commission schedule based on their network and partnership type.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-[#f8fafc] rounded-xl p-6 text-center border border-gray-100">
              <div className="w-12 h-12 rounded-xl bg-[#2E75B6]/10 flex items-center justify-center mx-auto mb-3">
                <DollarSign className="w-6 h-6 text-[#2E75B6]" />
              </div>
              <h3 className="font-bold text-gray-900 mb-2">Recurring revenue</h3>
              <p className="text-sm text-gray-600 leading-relaxed">
                Earn monthly commissions on every active referral. Paid on the 15th of each month.
              </p>
            </div>
            <div className="bg-[#f8fafc] rounded-xl p-6 text-center border border-gray-100">
              <div className="w-12 h-12 rounded-xl bg-[#2E75B6]/10 flex items-center justify-center mx-auto mb-3">
                <TrendingUp className="w-6 h-6 text-[#2E75B6]" />
              </div>
              <h3 className="font-bold text-gray-900 mb-2">Tiered structure</h3>
              <p className="text-sm text-gray-600 leading-relaxed">
                Higher rates for larger networks. Volume bonuses available for top performers.
              </p>
            </div>
            <div className="bg-[#f8fafc] rounded-xl p-6 text-center border border-gray-100">
              <div className="w-12 h-12 rounded-xl bg-[#2E75B6]/10 flex items-center justify-center mx-auto mb-3">
                <Briefcase className="w-6 h-6 text-[#2E75B6]" />
              </div>
              <h3 className="font-bold text-gray-900 mb-2">Co-marketing support</h3>
              <p className="text-sm text-gray-600 leading-relaxed">
                Custom referral materials, demo accounts, and sales support for your accounts.
              </p>
            </div>
          </div>
          <p className="text-center text-sm text-gray-500 mt-8">
            Specific commission rates discussed and finalized at partner approval.
          </p>
        </div>
      </section>

      <section className="py-16 px-6 bg-[#f8fafc]">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-[#1B2537] text-center mb-12">How It Works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#2E75B6]/10 flex items-center justify-center mx-auto mb-4">
                <UserCheck className="w-7 h-7 text-[#2E75B6]" />
              </div>
              <div className="text-xs font-bold text-[#2E75B6] uppercase tracking-wider mb-2">Step 1</div>
              <h3 className="font-bold text-gray-900 mb-2">Apply and get approved</h3>
              <p className="text-sm text-gray-500">24-hour turnaround on all applications</p>
            </div>
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#2E75B6]/10 flex items-center justify-center mx-auto mb-4">
                <Link2 className="w-7 h-7 text-[#2E75B6]" />
              </div>
              <div className="text-xs font-bold text-[#2E75B6] uppercase tracking-wider mb-2">Step 2</div>
              <h3 className="font-bold text-gray-900 mb-2">Get your unique referral link</h3>
              <p className="text-sm text-gray-500">Plus co-marketing materials and assets</p>
            </div>
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#2E75B6]/10 flex items-center justify-center mx-auto mb-4">
                <DollarSign className="w-7 h-7 text-[#2E75B6]" />
              </div>
              <div className="text-xs font-bold text-[#2E75B6] uppercase tracking-wider mb-2">Step 3</div>
              <h3 className="font-bold text-gray-900 mb-2">Earn commissions monthly</h3>
              <p className="text-sm text-gray-500">Paid on the 15th of each month, forever</p>
            </div>
          </div>
        </div>
      </section>

      <section id="partner-form" className="py-16 px-6">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#2E75B6]/10 rounded-full text-sm text-[#2E75B6] font-medium mb-4">
              <Send className="w-4 h-4" />
              Apply Now
            </div>
            <h2 className="text-2xl font-bold text-[#1B2537] mb-2">Partner Application</h2>
            <p className="text-sm text-gray-500">Fields marked with * are required</p>
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 md:p-8">
            <PartnerForm />
          </div>
        </div>
      </section>

      {/* Sprint 2 STEP 3 (BUG-16): swapped the page-specific custom dark
          footer (with its hand-rolled Privacy/Terms/Partners/Contact link
          row) for the standard LandingFooter so /partners matches the rest
          of the marketing surface. This also removes the self-link
          <Link href="/partner">Partners</Link> that would have become a
          self-redirect after the route rename above. */}
      <LandingFooter />
    </div>
  );
}
