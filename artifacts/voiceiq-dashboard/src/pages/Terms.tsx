import { Link } from "wouter";
import { FileText, Shield, CreditCard, Clock, AlertTriangle, Scale, Mail, ArrowLeft, Building2, MessageSquare } from "lucide-react";

const Section = ({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) => (
  <div className="mb-10">
    <div className="flex items-center gap-2.5 mb-4">
      <div className="w-8 h-8 rounded-lg bg-[#2E75B6]/10 flex items-center justify-center">
        <Icon className="w-4 h-4 text-[#2E75B6]" />
      </div>
      <h2 className="text-lg font-bold text-[#1B2537]">{title}</h2>
    </div>
    <div className="text-[15px] text-gray-600 leading-relaxed space-y-3 pl-10">{children}</div>
  </div>
);

export default function Terms() {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-100 sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <img src={`${import.meta.env.BASE_URL}neverr-logo.png`} alt="Neverr" className="h-10 w-auto md:h-12" />
          </Link>
          <Link href="/" className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-[#1B2537] transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to home
          </Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-[#1B2537] mb-2">Terms of Service</h1>
          <p className="text-sm text-gray-400">Last updated: April 1, 2025 · Neverr AI Inc.</p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8 md:p-10 shadow-sm">
          <p className="text-[15px] text-gray-600 mb-10 leading-relaxed">
            These Terms of Service ("Terms") govern your use of the Neverr AI receptionist platform and related services provided by Neverr AI Inc. ("Neverr," "we," "our," or "us"). By creating an account or using our services, you agree to be bound by these Terms.
          </p>

          <Section icon={FileText} title="1. Service Description">
            <p>Neverr is an AI-powered receptionist Software-as-a-Service (SaaS) platform that provides:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>AI voice agent for inbound call handling across 193+ industry templates</li>
              <li>Appointment booking via Google Calendar and Microsoft Outlook integration</li>
              <li>SMS messaging, post-call follow-ups, and campaign management via Twilio</li>
              <li>Post-call AI analysis powered by Anthropic Claude</li>
              <li>Call analytics, lead scoring, and performance dashboard</li>
              <li>Caller memory and contact management</li>
              <li>Multi-language support (32 languages)</li>
            </ul>
          </Section>

          <Section icon={AlertTriangle} title="2. Acceptable Use">
            <p>You agree not to use Neverr for:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Illegal Activities:</strong> Any use that violates federal, state, or local law</li>
              <li><strong>Harassment:</strong> Sending threatening, abusive, or harassing communications</li>
              <li><strong>Spam:</strong> Sending unsolicited bulk messages or using the platform for spam</li>
              <li><strong>Impersonation:</strong> Misrepresenting the AI as a human without appropriate disclosure</li>
            </ul>
            <p><strong>TCPA Compliance:</strong> You must comply with the Telephone Consumer Protection Act (TCPA) for all SMS campaigns, including obtaining proper consent before sending messages.</p>
            <p><strong>AI Disclosure:</strong> We recommend disclosing to callers that they are speaking with an AI assistant. Some jurisdictions may require this disclosure by law.</p>
          </Section>

          <Section icon={CreditCard} title="3. Payment Terms">
            <p><strong>Subscriptions:</strong> Neverr is offered as a monthly or annual subscription. All fees are in US dollars and billed on the anniversary of your signup date.</p>
            <p><strong>Setup Fees:</strong> One-time setup fees are non-refundable and due upon account activation.</p>
            <p><strong>30-Day Money-Back Guarantee:</strong> New customers may request a full refund of the subscription portion (not setup fees) within 30 days of their initial payment. Refund requests must be sent to <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a>.</p>
            <p><strong>Annual Plan Cancellation:</strong> Annual subscriptions require 30 days' written cancellation notice before the renewal date. Cancellations received less than 30 days before renewal will take effect at the next renewal period.</p>
            <p><strong>Overages:</strong> Usage exceeding your plan's included minutes or SMS will be billed at the overage rates listed in your plan details, invoiced at the end of each billing cycle.</p>
            <p><strong>Taxes:</strong> Prices do not include applicable taxes. You are responsible for all taxes associated with your use of Neverr.</p>
          </Section>

          <Section icon={Clock} title="4. Service Level Agreement">
            <p><strong>Uptime Target:</strong> We target 99.9% uptime for our core services, measured monthly. This excludes scheduled maintenance announced at least 48 hours in advance.</p>
            <p><strong>Service Credits:</strong> If monthly uptime falls below the SLA target:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>99.0% – 99.9%: 10% credit of monthly fees</li>
              <li>95.0% – 99.0%: 25% credit of monthly fees</li>
              <li>Below 95.0%: 50% credit of monthly fees</li>
            </ul>
          </Section>

          <Section icon={Scale} title="5. Limitation of Liability">
            <p>To the maximum extent permitted by law, Neverr AI Inc. shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, revenue, data, or business opportunities.</p>
            <p>Our total aggregate liability for any claims arising from or related to these Terms shall not exceed the total amount paid by you to Neverr in the twelve (12) months immediately preceding the claim.</p>
            <p><strong>No Guarantee of Results:</strong> While our AI receptionist is designed to improve call handling and capture leads, we do not guarantee any specific business outcomes or revenue results.</p>
          </Section>

          <Section icon={Building2} title="6. HIPAA Business Associate Agreement">
            <p><strong>Availability:</strong> A HIPAA Business Associate Agreement (BAA) is available for customers on the Professional plan ($749/mo) and above upon written request.</p>
            <p><strong>Request Process:</strong> To request a BAA, email <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a> with "BAA Request" in the subject line. BAAs are executed within 5 business days.</p>
            <p><strong>HIPAA Mode:</strong> Customers with an executed BAA must enable HIPAA compliance mode in their dashboard settings to activate additional PHI safeguards.</p>
          </Section>

          <Section icon={MessageSquare} title="7. SMS Terms">
            <p><strong>SMS TERMS</strong></p>
            <p>By providing your phone number and opting in, you consent to receive automated SMS messages from Neverr AI Inc. at the phone number provided.</p>
            <ol className="list-decimal pl-5 space-y-2">
              <li>You confirm you are the account holder or have permission to use this phone number.</li>
              <li>Consent is not a condition of purchase. You may use Neverr's services without consenting to marketing SMS.</li>
              <li>You may opt out at any time by replying STOP to any message. After opting out, you will receive one confirmation message and no further SMS will be sent.</li>
              <li>Reply HELP for assistance or contact <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a></li>
              <li>Message and data rates may apply depending on your carrier plan.</li>
              <li>Neverr AI Inc. will not be liable for delayed or undelivered messages.</li>
              <li>We do not sell or share your phone number with third parties for their marketing purposes.</li>
            </ol>
          </Section>

          <Section icon={Shield} title="8. Termination">
            <p><strong>Monthly Plans:</strong> You may cancel at any time. Cancellation takes effect at the end of your current billing period. No contracts, no cancellation fees.</p>
            <p><strong>Annual Plans:</strong> 30 days' written notice is required before your renewal date.</p>
            <p><strong>By Neverr:</strong> We may suspend or terminate your account if you violate these Terms, fail to pay fees, or engage in activity that could harm our platform or other users.</p>
            <p><strong>Data After Termination:</strong> Your data will be retained for 30 days after account closure to allow for export, after which it will be permanently deleted.</p>
          </Section>

          <Section icon={Scale} title="9. Governing Law">
            <p>These Terms shall be governed by and construed in accordance with the laws of the <strong>State of Delaware</strong>, without regard to its conflict of law principles.</p>
            <p>Any disputes arising from these Terms shall be resolved in the state or federal courts located in the State of Delaware.</p>
          </Section>

          <Section icon={Mail} title="10. Contact Us">
            <p>For questions about these Terms of Service:</p>
            <div className="bg-gray-50 rounded-xl p-4 mt-2">
              <p className="font-semibold text-[#1B2537]">Neverr AI Inc.</p>
              <p>Email: <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a></p>
              <p className="text-sm text-gray-400 mt-1">We respond to all inquiries within 48 hours.</p>
            </div>
          </Section>
        </div>
      </div>

      <footer className="bg-[#1B2537] py-8 px-6">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <img src={`${import.meta.env.BASE_URL}neverr-logo.png`} alt="Neverr" className="h-6 brightness-0 invert" />
          <div className="flex items-center gap-6 text-xs text-gray-400">
            <Link href="/privacy" className="hover:text-gray-200 transition-colors">Privacy Policy</Link>
            <span className="text-gray-500">Terms of Service</span>
            <Link href="/contact" className="hover:text-gray-200 transition-colors">Contact</Link>
          </div>
          <p className="text-[11px] text-gray-600">&copy; 2026 Neverr AI Inc.</p>
        </div>
      </footer>
    </div>
  );
}
