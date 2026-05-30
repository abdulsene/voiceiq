import { Link } from "wouter";
import { Shield, Mail, Lock, Database, FileText, UserCheck, Globe, Building2, ArrowLeft, Cookie, MessageSquare } from "lucide-react";

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

export default function Privacy() {
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
          <h1 className="text-3xl font-bold text-[#1B2537] mb-2">Privacy Policy</h1>
          <p className="text-sm text-gray-400">Last updated: April 1, 2025 · Neverr AI Inc.</p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8 md:p-10 shadow-sm">
          <p className="text-[15px] text-gray-600 mb-10 leading-relaxed">
            Neverr AI Inc. ("Neverr," "we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our AI receptionist platform and related services. For questions, contact us at <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a>.
          </p>

          <Section icon={Database} title="1. What Data We Collect">
            <p><strong>Call Recordings & Transcripts:</strong> We record and transcribe all calls handled by your AI receptionist to deliver the service, provide call analytics, and enable post-call AI analysis.</p>
            <p><strong>Business Information:</strong> Business name, industry, services, hours, greeting scripts, AI personality settings, calendar availability, and notification preferences.</p>
            <p><strong>Caller Information:</strong> Caller phone numbers, names (when provided), interaction history, appointment bookings, and lead status. This data powers our caller memory feature.</p>
            <p><strong>Account Data:</strong> Email address, password (hashed), phone number, billing information, and usage metrics.</p>
          </Section>

          <Section icon={FileText} title="2. How We Use Your Data">
            <p><strong>Service Operation:</strong> To operate your AI receptionist — answering calls, booking appointments, capturing leads, sending post-call SMS, and generating daily briefings.</p>
            <p><strong>AI Analysis:</strong> Call recordings and transcripts are processed by Anthropic Claude for post-call analysis including sentiment scoring, lead qualification, and actionable insights.</p>
            <p><strong>Notifications:</strong> To send you daily briefings, lead alerts, appointment confirmations, and performance reports via SMS and email.</p>
            <p><strong>No Data Sales:</strong> We never sell your personal information or your callers' data to third parties. Period.</p>
          </Section>

          <Section icon={Building2} title="3. HIPAA Compliance">
            <p><strong>HIPAA Mode:</strong> Healthcare customers can enable HIPAA compliance mode, which activates additional safeguards for Protected Health Information (PHI).</p>
            <p><strong>Business Associate Agreement:</strong> A BAA is available for customers on the Professional plan and above upon request. Contact <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a> to request a BAA.</p>
            <p><strong>PHI Handling:</strong> When HIPAA mode is enabled, all PHI is handled in strict accordance with HIPAA requirements, including access logging, minimum necessary standards, and encrypted storage.</p>
          </Section>

          <Section icon={Lock} title="4. Data Retention">
            <p><strong>Call Recordings:</strong> Retained for 90 days from the date of the call, then automatically and permanently deleted.</p>
            <p><strong>Transcripts & AI Analysis:</strong> Retained for 1 year from the date of the call.</p>
            <p><strong>Contact Data:</strong> Retained for the lifetime of your account, or until you request deletion.</p>
            <p><strong>Account Data:</strong> Retained for 30 days after account closure, then permanently deleted.</p>
          </Section>

          <Section icon={Globe} title="5. Third-Party Services">
            <p>We use the following third-party services to operate our platform. Each processes data only as necessary to provide its specific function:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>ElevenLabs</strong> — AI voice synthesis for your receptionist's voice</li>
              <li><strong>Twilio</strong> — Phone call routing and SMS delivery</li>
              <li><strong>Anthropic (Claude)</strong> — Post-call AI analysis, sentiment scoring, and lead qualification</li>
              <li><strong>Stripe</strong> — Payment processing and subscription billing</li>
              <li><strong>Supabase</strong> — Database hosting and authentication</li>
            </ul>
            <p className="mt-2">Each provider maintains its own privacy policy and security certifications. We select providers that meet or exceed industry-standard security practices.</p>
          </Section>

          <Section icon={UserCheck} title="6. Your Rights">
            <p><strong>Data Access:</strong> You can access all your data at any time through your Neverr dashboard, including call logs, transcripts, contacts, and analytics.</p>
            <p><strong>Data Export:</strong> You can export your data in standard formats (CSV, JSON) from the dashboard.</p>
            <p><strong>Data Deletion:</strong> You may request deletion of your account and all associated data by emailing <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a>. Deletion requests are completed within 30 days.</p>
            <p><strong>CCPA:</strong> California residents may exercise their right to know, delete, and opt out. We do not sell personal information.</p>
          </Section>

          <Section icon={MessageSquare} title="7. SMS Communications">
            <p><strong>SMS COMMUNICATIONS</strong></p>
            <p>Neverr AI sends the following types of SMS messages to business account holders who have opted in:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Service notifications (call summaries after each AI receptionist call)</li>
              <li>Lead alerts (when a hot lead calls your business)</li>
              <li>Daily briefing (morning summary of previous day's calls)</li>
              <li>Marketing messages (product updates, tips, promotional offers)</li>
            </ul>
            <p>Message frequency varies based on your call volume and notification settings.</p>
            <p>Message and data rates may apply.</p>
            <p><strong>To opt out:</strong> Reply STOP to any message to unsubscribe from all SMS communications.</p>
            <p><strong>To get help:</strong> Reply HELP to any message or contact <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a></p>
            <p><strong>To opt back in:</strong> Reply START to any message or update your notification settings in your Neverr dashboard.</p>
            <p><strong>Carrier:</strong> SMS messages are sent via Twilio. Supported carriers include AT&T, Verizon, T-Mobile, Sprint, and most US carriers.</p>
            <p>For questions about our SMS program, contact <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a></p>
          </Section>

          <Section icon={Cookie} title="8. Cookies">
            <p><strong>Session Cookies Only:</strong> We use session cookies solely to maintain your login state and preferences. These cookies expire when you close your browser or after your session ends.</p>
            <p><strong>No Tracking:</strong> We do not use tracking cookies, advertising cookies, or any third-party analytics trackers. We do not participate in ad networks or cross-site tracking.</p>
          </Section>

          <Section icon={Mail} title="9. Contact Us">
            <p>For any privacy-related questions, data requests, or concerns:</p>
            <div className="bg-gray-50 rounded-xl p-4 mt-2">
              <p className="font-semibold text-[#1B2537]">Neverr AI Inc.</p>
              <p>Email: <a href="mailto:hello@neverr.ai" className="text-[#2E75B6] hover:underline">hello@neverr.ai</a></p>
              <p className="text-sm text-gray-400 mt-1">We respond to all privacy inquiries within 48 hours.</p>
            </div>
          </Section>
        </div>
      </div>

      <footer className="bg-[#1B2537] py-8 px-6">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <img src={`${import.meta.env.BASE_URL}neverr-logo.png`} alt="Neverr" className="h-6 brightness-0 invert" />
          <div className="flex items-center gap-6 text-xs text-gray-400">
            <span className="text-gray-500">Privacy Policy</span>
            <Link href="/terms" className="hover:text-gray-200 transition-colors">Terms of Service</Link>
            <Link href="/contact" className="hover:text-gray-200 transition-colors">Contact</Link>
          </div>
          <p className="text-[11px] text-gray-600">&copy; 2026 Neverr AI Inc.</p>
        </div>
      </footer>
    </div>
  );
}
