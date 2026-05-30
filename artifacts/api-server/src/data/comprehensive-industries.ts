/**
 * Industry template catalogue for landing pages, demo generator, and
 * onboarding wizards. Source of truth for the `/api/industries` routes.
 *
 * Why this is a TS file and not a DB seed:
 *   * Templates and scripts are versioned with the codebase so changes
 *     ship through PR review (these influence sales messaging — they
 *     should not be silently editable in prod).
 *   * Lookups are O(1) Map reads — no DB round-trip per request.
 *   * Migration 003 still creates the mirror tables for a future admin
 *     editor, but no route currently writes to them.
 *
 * Conventions for script placeholders:
 *   * Use square-bracket tokens: `[BUSINESS_NAME]`, `[PROVIDER_NAME]`,
 *     `[CLIENT_NAME]`, etc.
 *   * Do NOT use `${...}` interpolation — the strings are stored as
 *     literal templates and substituted at demo-generation time. A bare
 *     `${THING}` would either be evaluated at module load (likely
 *     ReferenceError) or leak the literal `${THING}` string to the UI.
 */

export type TemplateCategory =
  | "lead_generation"
  | "appointment_booking"
  | "customer_service"
  | "sales_follow_up"
  | "emergency_response"
  | "compliance"
  | "upsell_cross_sell";

export interface IndustryTemplate {
  industryCode: string;
  industryName: string;
  industryCategory: string;
  naicsCode?: string;
  description: string;
  targetAudience: string[];
  painPoints: {
    primary: string[];
    secondary: string[];
    hidden: string[];
  };
  valuePropositions: {
    immediate: string[];
    longTerm: string[];
    competitive: string[];
  };
  features: {
    essential: string[];
    premium: string[];
    enterprise: string[];
  };
  templates: Array<{
    id: string;
    name: string;
    description: string;
    category: TemplateCategory;
    script: string;
    triggers: string[];
    outcomes: string[];
  }>;
  automationOpportunities: Array<{
    process: string;
    currentMethod: string;
    automatedSolution: string;
    timeSavings: string;
    costSavings: string;
    roiImprovement: string;
  }>;
  roiMetrics: {
    callVolumeIncrease: string;
    conversionImprovement: string;
    costReduction: string;
    revenueGrowth: string;
    timeToValue: string;
  };
  pricingModel: {
    starterTier: { monthly: number; callLimit: number | string; features: string[] };
    professionalTier: { monthly: number; callLimit: number | string; features: string[] };
    enterpriseTier: { monthly: number; callLimit: number | string; features: string[] };
  };
  complianceRequirements?: {
    regulations: string[];
    certifications: string[];
    dataProtection: string[];
    industryStandards: string[];
  };
  seasonalPatterns?: {
    peakSeasons: string[];
    strategies: Record<string, string>;
  };
}

export interface IndustryCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  sortOrder: number;
  isFeatured: boolean;
}

export const INDUSTRY_CATEGORIES: IndustryCategory[] = [
  { id: "healthcare",             name: "Healthcare",            description: "Medical practices, dental offices, veterinary clinics, and healthcare services",           icon: "🏥", sortOrder: 1, isFeatured: true },
  { id: "professional_services",  name: "Professional Services", description: "Legal, accounting, consulting, and specialized professional services",                     icon: "💼", sortOrder: 2, isFeatured: true },
  { id: "legal_services",         name: "Legal Services",        description: "Law firms, immigration attorneys, and legal aid organizations",                            icon: "⚖️", sortOrder: 3, isFeatured: true },
  { id: "health_fitness",         name: "Health & Fitness",      description: "Gyms, personal trainers, wellness centers, and fitness services",                          icon: "💪", sortOrder: 4, isFeatured: true },
  { id: "transportation",         name: "Transportation",        description: "Car rentals, logistics, taxi services, and transportation companies",                      icon: "🚗", sortOrder: 5, isFeatured: true },
  { id: "specialized_retail",     name: "Specialized Retail",    description: "Specialty stores, niche retail, and regulated retail businesses",                          icon: "🏪", sortOrder: 6, isFeatured: false },
];

export const REVOLUTIONARY_INDUSTRIES: IndustryTemplate[] = [
  // ========================================================================
  // HEALTHCARE
  // ========================================================================
  {
    industryCode: "DENTAL_PRACTICES",
    industryName: "Dental Practices",
    industryCategory: "Healthcare",
    naicsCode: "621210",
    description: "Comprehensive dental care practices including general dentistry, orthodontics, and specialized treatments",
    targetAudience: ["Solo practitioners", "Group practices", "Dental service organizations", "Specialty clinics"],
    painPoints: {
      primary: ["High no-show rates (30-40%)", "Complex insurance verification", "Emergency appointment scheduling"],
      secondary: ["Treatment plan follow-ups", "Recall scheduling", "Payment collection"],
      hidden: ["Patient anxiety management", "Referral tracking", "Preventive care compliance"],
    },
    valuePropositions: {
      immediate: ["Reduce no-shows by 60%", "24/7 appointment booking", "Automated insurance verification"],
      longTerm: ["Increase practice revenue by 35%", "Improve patient satisfaction scores", "Scale without adding staff"],
      competitive: ["HIPAA-compliant communications", "Integration with practice management software", "Multilingual support"],
    },
    features: {
      essential: ["Appointment reminders", "Emergency triage", "Basic patient intake"],
      premium: ["Insurance verification", "Treatment plan reminders", "Recall campaigns"],
      enterprise: ["Multi-location management", "Advanced reporting", "Provider scheduling optimization"],
    },
    templates: [
      {
        id: "dental_appointment_booking",
        name: "Smart Appointment Booking",
        description: "AI-powered scheduling that considers procedure types, provider availability, and patient preferences",
        category: "appointment_booking",
        script: `Hi! I'm Neverr, the dental assistant for [PRACTICE_NAME]. I can help you schedule your appointment today.

What type of service do you need?
1. Routine cleaning and exam
2. Emergency dental care
3. Cosmetic consultation
4. Follow-up treatment

I'll find the perfect time that works with your schedule and Dr. [PROVIDER]'s availability.`,
        triggers: ["New patient inquiry", "Existing patient rebooking", "Emergency calls"],
        outcomes: ["Appointment scheduled", "Waitlist placement", "Emergency triage"],
      },
      {
        id: "dental_insurance_verification",
        name: "Automated Insurance Verification",
        description: "Real-time insurance benefit verification and pre-treatment cost estimates",
        category: "customer_service",
        script: `I'll help verify your insurance coverage right now. Can you provide:

1. Your insurance company name
2. Your member ID number
3. The treatment you're considering

I'll check your benefits instantly and provide an exact cost estimate for your visit.`,
        triggers: ["Insurance inquiry", "Pre-treatment verification", "Cost estimate requests"],
        outcomes: ["Coverage confirmed", "Pre-authorization initiated", "Payment plan offered"],
      },
      {
        id: "dental_emergency_triage",
        name: "Emergency Dental Triage",
        description: "Immediate assessment and routing of dental emergencies with priority scheduling",
        category: "emergency_response",
        script: `This is Neverr for [PRACTICE_NAME] emergency line. I understand you're experiencing dental pain.

On a scale of 1-10, how would you rate your pain level?

Can you describe your symptoms? This helps me determine if you need:
- Immediate same-day care
- Next-day appointment
- Home care instructions until your visit`,
        triggers: ["After-hours emergency", "Severe pain reports", "Dental trauma"],
        outcomes: ["Emergency appointment scheduled", "After-hours referral", "Pain management guidance"],
      },
    ],
    automationOpportunities: [
      {
        process: "Appointment Reminders",
        currentMethod: "Manual staff calls (15 min per reminder)",
        automatedSolution: "AI voice confirmations with rescheduling capability",
        timeSavings: "12 hours per week",
        costSavings: "$2,400/month in staff time",
        roiImprovement: "60% reduction in no-shows = $8,000 additional revenue",
      },
      {
        process: "Insurance Verification",
        currentMethod: "Staff calls to insurance companies (30 min per verification)",
        automatedSolution: "Real-time automated verification with patient cost estimates",
        timeSavings: "20 hours per week",
        costSavings: "$4,000/month in staff time",
        roiImprovement: "95% faster verifications = 40% more new patients",
      },
    ],
    roiMetrics: {
      callVolumeIncrease: "150% more inquiries handled",
      conversionImprovement: "45% inquiry-to-appointment rate",
      costReduction: "65% less front desk overhead",
      revenueGrowth: "$15,000-25,000 monthly revenue increase",
      timeToValue: "2 weeks implementation",
    },
    pricingModel: {
      starterTier:      { monthly: 299,  callLimit: 500,         features: ["Basic scheduling", "Appointment reminders", "Emergency triage"] },
      professionalTier: { monthly: 599,  callLimit: 1500,        features: ["Insurance verification", "Recall campaigns", "Multi-provider scheduling"] },
      enterpriseTier:   { monthly: 1299, callLimit: "Unlimited", features: ["Multi-location management", "Advanced analytics", "Custom integrations"] },
    },
    complianceRequirements: {
      regulations: ["HIPAA", "State dental board regulations"],
      certifications: ["SOC 2 Type II", "HITECH compliance"],
      dataProtection: ["PHI encryption", "Audit trails", "Access controls"],
      industryStandards: ["ADA guidelines", "CAQH standards"],
    },
  },

  {
    industryCode: "VETERINARY_CLINICS",
    industryName: "Veterinary Clinics",
    industryCategory: "Healthcare",
    naicsCode: "541940",
    description: "Animal healthcare practices including general veterinary care, emergency services, and specialty treatments",
    targetAudience: ["General practice vets", "Emergency animal hospitals", "Specialty veterinary clinics", "Mobile vet services"],
    painPoints: {
      primary: ["High-stress emergency situations", "Complex scheduling across multiple doctors", "Emotional pet owner conversations"],
      secondary: ["Vaccine reminders", "Surgery follow-ups", "Medication refill requests"],
      hidden: ["End-of-life care discussions", "Multi-pet family management", "Seasonal demand fluctuations"],
    },
    valuePropositions: {
      immediate: ["Compassionate 24/7 emergency triage", "Automated vaccine reminders", "Stress-free scheduling"],
      longTerm: ["Increase client retention by 40%", "Streamline emergency protocols", "Reduce staff emotional burnout"],
      competitive: ["Empathetic AI trained on pet care scenarios", "Integration with veterinary management systems", "Bilingual pet care support"],
    },
    features: {
      essential: ["Emergency triage", "Vaccine reminders", "Appointment scheduling"],
      premium: ["Multi-pet family tracking", "Prescription refill management", "Post-surgery follow-ups"],
      enterprise: ["24/7 emergency overflow support", "Advanced clinical decision support", "Telehealth consultations"],
    },
    templates: [
      {
        id: "vet_emergency_triage",
        name: "Emergency Pet Triage",
        description: "Compassionate emergency assessment with immediate care routing",
        category: "emergency_response",
        script: `I understand you're worried about [PET_NAME]. Let me help you get the right care immediately.

What symptoms are you seeing?
1. Difficulty breathing or choking
2. Severe injury or bleeding
3. Unable to urinate or defecate
4. Seizures or loss of consciousness
5. Other concerns

Based on what you tell me, I'll connect you with our emergency team or schedule urgent care.`,
        triggers: ["Emergency calls", "After-hours urgent care", "Pet owner distress"],
        outcomes: ["Emergency appointment scheduled", "Immediate veterinary consultation", "Home care guidance"],
      },
    ],
    automationOpportunities: [
      {
        process: "Vaccine Reminder Campaigns",
        currentMethod: "Quarterly postcard mailings and manual phone calls",
        automatedSolution: "AI-driven personalized reminders based on each pet's vaccine schedule",
        timeSavings: "15 hours per week",
        costSavings: "$3,000/month in labor + $800/month in postage",
        roiImprovement: "70% increase in vaccine compliance = $12,000 additional monthly revenue",
      },
    ],
    roiMetrics: {
      callVolumeIncrease: "200% more emergency calls handled efficiently",
      conversionImprovement: "55% new client conversion rate",
      costReduction: "50% reduction in missed appointments",
      revenueGrowth: "$18,000-30,000 monthly increase",
      timeToValue: "1 week implementation",
    },
    pricingModel: {
      starterTier:      { monthly: 399,  callLimit: 800,         features: ["Emergency triage", "Basic scheduling", "Vaccine reminders"] },
      professionalTier: { monthly: 799,  callLimit: 2000,        features: ["Multi-pet tracking", "Post-care follow-ups", "Prescription management"] },
      enterpriseTier:   { monthly: 1599, callLimit: "Unlimited", features: ["24/7 emergency support", "Telehealth integration", "Multi-location management"] },
    },
  },

  // ========================================================================
  // PROFESSIONAL / LEGAL SERVICES
  // ========================================================================
  {
    industryCode: "TAX_PREPARATION",
    industryName: "Tax Preparation Services",
    industryCategory: "Professional Services",
    naicsCode: "541213",
    description: "Individual and business tax preparation, planning, and compliance services",
    targetAudience: ["Independent tax preparers", "CPA firms", "Tax preparation franchises", "Seasonal tax businesses"],
    painPoints: {
      primary: ["Extreme seasonal demand (Jan-Apr)", "Complex document collection", "IRS deadline pressure"],
      secondary: ["Client document organization", "Multi-year client retention", "Pricing transparency"],
      hidden: ["Year-round business development", "Tax law change communication", "Audit support anxiety"],
    },
    valuePropositions: {
      immediate: ["Handle 300% more inquiries during tax season", "Automate document collection", "24/7 client support"],
      longTerm: ["Convert seasonal clients to year-round advisory services", "Build recurring revenue streams", "Scale without seasonal staffing"],
      competitive: ["IRS-compliant secure communications", "Multi-language tax assistance", "Real-time refund tracking"],
    },
    features: {
      essential: ["Appointment scheduling", "Document collection reminders", "Refund status updates"],
      premium: ["Tax planning consultations", "Audit support coordination", "Business tax workflow management"],
      enterprise: ["Multi-location management", "Advanced tax law updates", "CPA firm integration"],
    },
    templates: [
      {
        id: "tax_season_intake",
        name: "Tax Season Client Intake",
        description: "Streamlined tax preparation intake with document collection automation",
        category: "lead_generation",
        script: `Welcome to [FIRM_NAME]! I'm here to make your tax preparation smooth and stress-free.

Let me help you get started:
1. Individual tax return (1040)
2. Business tax return
3. Tax planning consultation
4. Prior year amendment

I'll guide you through exactly which documents you need and can schedule your appointment for maximum refund potential.`,
        triggers: ["New client inquiry", "Returning client scheduling", "Document questions"],
        outcomes: ["Appointment scheduled", "Document checklist provided", "Service pricing confirmed"],
      },
      {
        id: "document_collection",
        name: "Automated Document Collection",
        description: "Smart document collection with reminders and secure upload coordination",
        category: "customer_service",
        script: `Hi [CLIENT_NAME], this is Neverr from [FIRM_NAME]. Your tax appointment is coming up and I want to make sure you have everything ready.

Based on your situation, you'll need:
- W-2s from all employers
- 1099s for any contract work
- Investment statements (1099-DIV, 1099-INT)
- Receipts for deductions you plan to claim

I can send you a secure link to upload documents, or you can bring them to your appointment. Which would you prefer?`,
        triggers: ["Pre-appointment reminder", "Missing document follow-up", "Client document questions"],
        outcomes: ["Documents uploaded", "Appointment confirmed", "Additional services scheduled"],
      },
      {
        id: "year_round_advisory",
        name: "Year-Round Tax Advisory",
        description: "Proactive tax planning and advisory service promotion for ongoing client relationships",
        category: "upsell_cross_sell",
        script: `Hi [CLIENT_NAME], now that we've completed your tax return, I wanted to share some opportunities to save even more next year.

Based on your return, I see potential savings through:
- Quarterly tax planning sessions
- Business structure optimization
- Retirement contribution strategies
- Investment tax planning

Would you like to schedule a 15-minute consultation to discuss how we can reduce your taxes for next year?`,
        triggers: ["Post-tax completion", "Year-round engagement", "Strategic planning opportunities"],
        outcomes: ["Advisory consultation scheduled", "Ongoing services enrolled", "Referral opportunities identified"],
      },
    ],
    automationOpportunities: [
      {
        process: "Seasonal Client Reactivation",
        currentMethod: "Mass email campaigns with 3% response rate",
        automatedSolution: "Personalized voice calls with tax situation updates and deadline reminders",
        timeSavings: "25 hours per week during tax season",
        costSavings: "$5,000/month in marketing spend",
        roiImprovement: "400% increase in client reactivation = $50,000 additional seasonal revenue",
      },
      {
        process: "Document Collection and Organization",
        currentMethod: "Manual back-and-forth emails and phone calls",
        automatedSolution: "AI-guided document collection with smart reminders and secure upload",
        timeSavings: "30 hours per week",
        costSavings: "$6,000/month in administrative overhead",
        roiImprovement: "60% faster preparation time = 40% more clients served",
      },
    ],
    roiMetrics: {
      callVolumeIncrease: "400% more inquiries handled during peak season",
      conversionImprovement: "65% inquiry-to-client conversion",
      costReduction: "70% reduction in seasonal staffing needs",
      revenueGrowth: "$75,000-120,000 additional seasonal revenue",
      timeToValue: "Immediate implementation before tax season",
    },
    pricingModel: {
      starterTier:      { monthly: 199, callLimit: 1000,        features: ["Seasonal scheduling", "Document reminders", "Basic client intake"] },
      professionalTier: { monthly: 499, callLimit: 3000,        features: ["Year-round advisory", "Advanced document collection", "Multi-service coordination"] },
      enterpriseTier:   { monthly: 999, callLimit: "Unlimited", features: ["Multi-location support", "CPA integration", "Advanced tax law updates"] },
    },
    seasonalPatterns: {
      peakSeasons: ["January-April (tax season)", "December (tax planning)"],
      strategies: {
        "January-April": "Maximum capacity utilization with overflow support",
        "May-November":  "Advisory services and next-year client development",
        "December":      "Year-end tax planning and strategic consultations",
      },
    },
  },

  {
    industryCode: "IMMIGRATION_LAW",
    industryName: "Immigration Law Firms",
    industryCategory: "Legal Services",
    naicsCode: "541110",
    description: "Legal services specializing in immigration, visa applications, and citizenship processes",
    targetAudience: ["Immigration law firms", "Solo immigration attorneys", "Legal aid organizations", "Corporate immigration specialists"],
    painPoints: {
      primary: ["Complex case status tracking", "Multi-language client communication", "USCIS deadline management"],
      secondary: ["Document collection across multiple languages", "Family-based case coordination", "Fee payment processing"],
      hidden: ["Client anxiety and emotional support", "Regulatory change communications", "Multi-generational family planning"],
    },
    valuePropositions: {
      immediate: ["Multilingual case status updates", "Automated document collection", "USCIS deadline tracking"],
      longTerm: ["Scale practice without language barriers", "Improve case completion rates", "Build community trust"],
      competitive: ["Native-level multilingual support", "Immigration-specific legal workflows", "Cultural sensitivity training"],
    },
    features: {
      essential: ["Multilingual intake", "Case status updates", "Document collection coordination"],
      premium: ["USCIS form assistance", "Family case management", "Deadline reminder systems"],
      enterprise: ["Corporate immigration workflows", "Advanced compliance tracking", "Multi-office coordination"],
    },
    templates: [
      {
        id: "immigration_intake",
        name: "Multilingual Immigration Intake",
        description: "Comprehensive intake process in 15+ languages with cultural sensitivity",
        category: "lead_generation",
        script: `Welcome to [FIRM_NAME]. I can assist you in English, Spanish, Mandarin, Arabic, and many other languages.

What type of immigration assistance do you need today?
1. Family-based immigration
2. Employment-based visa
3. Asylum or refugee status
4. Citizenship application
5. Case status update

I'll connect you with an attorney who specializes in your specific situation and can communicate in your preferred language.`,
        triggers: ["New client inquiry", "Language preference requests", "Case type clarification"],
        outcomes: ["Attorney consultation scheduled", "Language specialist assigned", "Document checklist provided"],
      },
      {
        id: "case_status_updates",
        name: "Automated Case Status Updates",
        description: "Proactive case status communication with USCIS tracking integration",
        category: "customer_service",
        // NOTE: the original spec used `${URGENT_ACTION_REQUIRED ? ... }` here,
        // which would explode at module load. We replace it with a literal
        // [URGENT_ACTION_NOTE] token that the demo runner can substitute.
        script: `Hi [CLIENT_NAME], this is an update on your [CASE_TYPE] case.

Current status: [USCIS_STATUS]
Expected next step: [NEXT_MILESTONE]
Estimated timeline: [TIMELINE_ESTIMATE]

[URGENT_ACTION_NOTE]

You can always call us for detailed updates or questions about your case.`,
        triggers: ["USCIS status change", "Deadline approaching", "Required action from client"],
        outcomes: ["Client informed", "Urgent action scheduled", "Anxiety reduced through communication"],
      },
    ],
    automationOpportunities: [
      {
        process: "Multilingual Client Communication",
        currentMethod: "Hiring translators and bilingual staff for each language",
        automatedSolution: "AI-powered multilingual communication with cultural context",
        timeSavings: "20 hours per week across multiple languages",
        costSavings: "$8,000/month in translation and interpreter costs",
        roiImprovement: "Serve 300% more language communities = $25,000 additional monthly revenue",
      },
      {
        process: "USCIS Document and Deadline Tracking",
        currentMethod: "Manual calendar tracking with high error rates",
        automatedSolution: "Automated USCIS integration with proactive deadline management",
        timeSavings: "15 hours per week in administrative tasks",
        costSavings: "$3,000/month in case management overhead",
        roiImprovement: "95% reduction in missed deadlines = prevents $50,000+ in case complications",
      },
    ],
    roiMetrics: {
      callVolumeIncrease: "250% more multilingual inquiries handled",
      conversionImprovement: "70% consultation-to-retainer conversion",
      costReduction: "60% reduction in language support costs",
      revenueGrowth: "$30,000-50,000 monthly increase",
      timeToValue: "1 week with immediate multilingual capabilities",
    },
    pricingModel: {
      starterTier:      { monthly: 599,  callLimit: 1000,        features: ["5-language support", "Basic case management", "Document collection"] },
      professionalTier: { monthly: 1199, callLimit: 2500,        features: ["15-language support", "USCIS integration", "Family case coordination"] },
      enterpriseTier:   { monthly: 2399, callLimit: "Unlimited", features: ["Unlimited languages", "Corporate immigration workflows", "Multi-office management"] },
    },
    complianceRequirements: {
      regulations: ["State bar regulations", "USCIS compliance", "Attorney-client privilege"],
      certifications: ["Legal professional compliance", "Data security standards"],
      dataProtection: ["Client confidentiality", "Secure document handling", "Privacy protection"],
      industryStandards: ["ABA guidelines", "Immigration law best practices"],
    },
  },

  // ========================================================================
  // HEALTH & FITNESS
  // ========================================================================
  {
    industryCode: "FITNESS_GYMS",
    industryName: "Fitness Centers & Gyms",
    industryCategory: "Health & Fitness",
    naicsCode: "713940",
    description: "Fitness centers, gyms, health clubs, and specialized fitness facilities",
    targetAudience: ["Independent gyms", "Chain fitness centers", "Boutique fitness studios", "Corporate wellness centers"],
    painPoints: {
      primary: ["High membership churn rates", "Class booking complexity", "Member engagement decline"],
      secondary: ["Personal training scheduling", "Membership sales follow-up", "Equipment maintenance coordination"],
      hidden: ["Member motivation and retention", "Seasonal membership fluctuations", "Community building challenges"],
    },
    valuePropositions: {
      immediate: ["Reduce churn by 40%", "Automate class bookings", "24/7 member support"],
      longTerm: ["Build member community engagement", "Increase lifetime value by 60%", "Scale without front desk staffing"],
      competitive: ["Fitness-specific motivation coaching", "Integrated wearable device support", "Personalized workout recommendations"],
    },
    features: {
      essential: ["Class booking", "Membership inquiries", "Facility hours information"],
      premium: ["Personal training scheduling", "Member progress tracking", "Renewal campaigns"],
      enterprise: ["Multi-location management", "Corporate membership coordination", "Advanced member analytics"],
    },
    templates: [
      {
        id: "fitness_membership_sales",
        name: "Intelligent Membership Sales",
        description: "Data-driven membership sales with personalized fitness goal alignment",
        category: "lead_generation",
        script: `Welcome to [GYM_NAME]! I'm excited to help you start your fitness journey.

What are your main fitness goals?
1. Weight loss and cardio improvement
2. Strength building and muscle gain
3. General health and wellness
4. Sport-specific training
5. Rehabilitation and injury prevention

Based on your goals, I'll recommend the perfect membership and show you exactly how our facilities and trainers can help you succeed.`,
        triggers: ["New member inquiry", "Tour request", "Membership information"],
        outcomes: ["Tour scheduled", "Trial membership started", "Personal training consultation booked"],
      },
      {
        id: "class_booking_system",
        name: "Smart Class Booking & Waitlists",
        description: "Intelligent class scheduling with automatic waitlist management",
        category: "appointment_booking",
        script: `Hi [MEMBER_NAME]! Ready to book your next workout?

Here are popular classes available this week:
- [CLASS_TYPE] with [INSTRUCTOR] - [AVAILABLE_SLOTS]
- [CLASS_TYPE] with [INSTRUCTOR] - [AVAILABLE_SLOTS]

If your preferred time is full, I can add you to the waitlist and automatically book you when a spot opens. I'll send you a confirmation text right away.`,
        triggers: ["Class booking request", "Waitlist management", "Schedule changes"],
        outcomes: ["Class booked", "Waitlist placement", "Alternative class suggested"],
      },
      {
        id: "member_retention_coach",
        name: "AI Fitness Motivation Coach",
        description: "Proactive member engagement with personalized motivation and progress tracking",
        category: "customer_service",
        script: `Hi [MEMBER_NAME]! I noticed you haven't been to the gym in [DAYS] days. No judgment - life gets busy!

I'm here to help you get back on track. What's been challenging lately?
1. Schedule conflicts
2. Lack of motivation
3. Not seeing results
4. Intimidation or uncertainty

Let me help you overcome these obstacles and rediscover your fitness momentum. I can even book you a complimentary session with a trainer to restart your routine.`,
        triggers: ["Member absence tracking", "Engagement decline", "Retention risk assessment"],
        outcomes: ["Member re-engagement", "Trainer consultation scheduled", "Personalized support plan created"],
      },
    ],
    automationOpportunities: [
      {
        process: "Member Retention and Re-engagement",
        currentMethod: "Generic email campaigns with 5% engagement rate",
        automatedSolution: "Personalized voice outreach with motivational coaching and barrier identification",
        timeSavings: "20 hours per week in member outreach",
        costSavings: "$4,000/month in retention marketing",
        roiImprovement: "40% churn reduction = $15,000 additional monthly recurring revenue",
      },
      {
        process: "Personal Training Sales and Scheduling",
        currentMethod: "Front desk staff booking with frequent scheduling conflicts",
        automatedSolution: "AI-powered trainer matching with intelligent scheduling optimization",
        timeSavings: "12 hours per week in scheduling coordination",
        costSavings: "$2,500/month in administrative overhead",
        roiImprovement: "60% more PT sessions booked = $12,000 additional monthly revenue",
      },
    ],
    roiMetrics: {
      callVolumeIncrease: "300% more member inquiries handled",
      conversionImprovement: "55% trial-to-membership conversion",
      costReduction: "50% reduction in front desk staffing",
      revenueGrowth: "$20,000-35,000 monthly increase",
      timeToValue: "2 weeks with immediate member engagement improvement",
    },
    pricingModel: {
      starterTier:      { monthly: 399,  callLimit: 1500,        features: ["Class booking", "Membership sales", "Basic member support"] },
      professionalTier: { monthly: 799,  callLimit: 3500,        features: ["Retention coaching", "PT scheduling", "Member analytics"] },
      enterpriseTier:   { monthly: 1599, callLimit: "Unlimited", features: ["Multi-location support", "Corporate memberships", "Advanced member insights"] },
    },
    seasonalPatterns: {
      peakSeasons: ["January-March (New Year)", "May-July (Summer prep)"],
      strategies: {
        "January-March":   "Maximum capacity for New Year resolution surge",
        "May-July":        "Summer body preparation campaigns and class expansion",
        "August-December": "Member retention focus and holiday maintenance programs",
      },
    },
  },

  {
    industryCode: "PERSONAL_TRAINERS",
    industryName: "Personal Trainers",
    industryCategory: "Health & Fitness",
    naicsCode: "712990",
    description: "Independent personal trainers and specialized fitness coaching services",
    targetAudience: ["Independent personal trainers", "Mobile fitness coaches", "Specialized fitness consultants", "Online fitness coaches"],
    painPoints: {
      primary: ["Irregular client scheduling", "Client motivation and accountability", "Business scaling limitations"],
      secondary: ["Payment collection and tracking", "Program progression monitoring", "Client acquisition costs"],
      hidden: ["Work-life balance management", "Seasonal client fluctuations", "Injury liability concerns"],
    },
    valuePropositions: {
      immediate: ["Automate client scheduling", "Improve client accountability", "24/7 client support"],
      longTerm: ["Scale beyond 1-on-1 limitations", "Build passive income streams", "Create systematic client success"],
      competitive: ["Personalized fitness journey tracking", "Nutrition and wellness integration", "Progress photo and measurement automation"],
    },
    features: {
      essential: ["Client scheduling", "Workout reminders", "Progress tracking"],
      premium: ["Nutrition coaching", "Habit tracking", "Client milestone celebrations"],
      enterprise: ["Group coaching coordination", "Online program delivery", "Multi-trainer business management"],
    },
    templates: [
      {
        id: "personal_training_consultation",
        name: "Fitness Consultation & Goal Setting",
        description: "Comprehensive fitness assessment with personalized goal setting",
        category: "lead_generation",
        script: `Hi there! I'm [TRAINER_NAME]'s AI assistant. I'm here to help you transform your fitness and achieve results you've always wanted.

Let's start with your primary fitness goal:
1. Weight loss (how much and by when?)
2. Strength and muscle building
3. Athletic performance improvement
4. Health and wellness optimization
5. Post-injury rehabilitation

I'll help create a personalized plan that fits your schedule, experience level, and lifestyle. When would you like to schedule your complimentary assessment?`,
        triggers: ["New client inquiry", "Fitness consultation request", "Goal clarification"],
        outcomes: ["Assessment scheduled", "Program proposal created", "Training package recommended"],
      },
      {
        id: "client_accountability_coach",
        name: "AI Accountability Coach",
        description: "Proactive client motivation and progress tracking between sessions",
        category: "customer_service",
        script: `Hey [CLIENT_NAME]! This is your accountability check-in from [TRAINER_NAME]'s team.

How are you feeling about yesterday's workout? And more importantly, are you ready to crush today's activities?

Today's focus: [SCHEDULED_ACTIVITY]
This week's goal: [WEEKLY_TARGET]

Remember, [TRAINER_NAME] believes in you, and so do I! If you're struggling with motivation or have questions, I'm here to help or connect you with [TRAINER_NAME] directly.`,
        triggers: ["Daily check-ins", "Missed workout detection", "Goal milestone tracking"],
        outcomes: ["Motivation boosted", "Workout completed", "Trainer consultation requested"],
      },
      {
        id: "progress_celebration",
        name: "Progress Milestone Celebration",
        description: "Automated celebration of client achievements with progress sharing",
        category: "customer_service",
        script: `AMAZING NEWS, [CLIENT_NAME]!

You just hit a major milestone: [ACHIEVEMENT_DESCRIPTION]

Since starting with [TRAINER_NAME]:
- You've lost [WEIGHT_LOST] pounds
- Increased strength by [STRENGTH_GAIN]%
- Completed [WORKOUTS_COMPLETED] sessions
- Built [HABIT_STREAK] day consistency streak

[TRAINER_NAME] is so proud of your dedication! Ready to set your next challenge goal?`,
        triggers: ["Goal achievement", "Progress milestones", "Consistency streaks"],
        outcomes: ["Client motivation increased", "Next goal set", "Success story documented"],
      },
    ],
    automationOpportunities: [
      {
        process: "Client Accountability and Motivation",
        currentMethod: "Manual check-in calls and text messages",
        automatedSolution: "AI-powered daily motivation with progress tracking and personalized encouragement",
        timeSavings: "10 hours per week in client communication",
        costSavings: "$2,000/month in time value",
        roiImprovement: "70% better client retention = $8,000 additional monthly recurring revenue",
      },
      {
        process: "Program Delivery and Progress Tracking",
        currentMethod: "Manual workout logging and progress photos via text/email",
        automatedSolution: "Automated progress tracking with photo analysis and program adjustments",
        timeSavings: "8 hours per week in progress management",
        costSavings: "$1,600/month in administrative time",
        roiImprovement: "Serve 50% more clients simultaneously = $6,000 additional monthly revenue",
      },
    ],
    roiMetrics: {
      callVolumeIncrease: "200% more client inquiries handled",
      conversionImprovement: "80% consultation-to-client conversion",
      costReduction: "60% reduction in administrative overhead",
      revenueGrowth: "$8,000-15,000 monthly increase per trainer",
      timeToValue: "1 week with immediate client engagement tools",
    },
    pricingModel: {
      starterTier:      { monthly: 149, callLimit: 500,         features: ["Client scheduling", "Basic accountability", "Progress tracking"] },
      professionalTier: { monthly: 299, callLimit: 1200,        features: ["Advanced coaching", "Nutrition integration", "Habit tracking"] },
      enterpriseTier:   { monthly: 599, callLimit: "Unlimited", features: ["Multi-trainer coordination", "Group coaching", "Business analytics"] },
    },
  },

  // ========================================================================
  // TRANSPORTATION
  // ========================================================================
  {
    industryCode: "CAR_RENTAL",
    industryName: "Car Rental Companies",
    industryCategory: "Transportation",
    naicsCode: "532111",
    description: "Vehicle rental services including short-term, long-term, and specialty vehicle rentals",
    targetAudience: ["Independent rental agencies", "Airport rental locations", "Specialty vehicle rentals", "Corporate fleet services"],
    painPoints: {
      primary: ["Complex availability tracking", "Damage assessment disputes", "Peak season demand management"],
      secondary: ["Insurance upselling complexity", "Vehicle return inspections", "Customer service during breakdowns"],
      hidden: ["Customer anxiety about hidden fees", "Cross-selling opportunities", "Loyalty program engagement"],
    },
    valuePropositions: {
      immediate: ["Real-time availability updates", "Streamlined damage documentation", "Automated pickup reminders"],
      longTerm: ["Increase upsell revenue by 45%", "Reduce customer service costs", "Improve fleet utilization rates"],
      competitive: ["Transparent pricing communication", "Multilingual travel support", "Integration with travel booking platforms"],
    },
    features: {
      essential: ["Reservation management", "Vehicle availability", "Pickup/return coordination"],
      premium: ["Insurance consultation", "Upgrade recommendations", "Damage documentation"],
      enterprise: ["Fleet optimization", "Corporate account management", "Multi-location coordination"],
    },
    templates: [
      {
        id: "car_rental_reservation",
        name: "Smart Vehicle Reservation System",
        description: "Intelligent vehicle matching with real-time availability and upgrade suggestions",
        category: "appointment_booking",
        script: `Welcome to [RENTAL_COMPANY]! I'm here to find you the perfect vehicle for your trip.

Let me help you with your rental:

Pickup location: [LOCATION]
Dates: [PICKUP_DATE] to [RETURN_DATE]

Based on availability, I can offer:
1. [VEHICLE_CLASS] - $[RATE]/day - Perfect for city driving
2. [VEHICLE_CLASS] - $[RATE]/day - Great for road trips
3. [VEHICLE_CLASS] - $[RATE]/day - Premium comfort option

Would you like me to check for any current promotions or explain our insurance options?`,
        triggers: ["New reservation inquiry", "Vehicle availability check", "Booking assistance"],
        outcomes: ["Reservation completed", "Upgrade accepted", "Insurance added"],
      },
      {
        id: "damage_documentation",
        name: "Automated Damage Documentation",
        description: "Streamlined damage reporting with photo guidance and fair resolution",
        category: "customer_service",
        script: `I understand you're reporting vehicle damage. Let me help you document this quickly and fairly.

Please describe what happened:
1. When did you first notice the damage?
2. Can you describe the location and type of damage?
3. Were there any contributing factors (weather, parking, etc.)?

I'll guide you through taking photos that ensure fair assessment. Our goal is a transparent process that protects both you and our vehicles.`,
        triggers: ["Damage report", "Vehicle inspection", "Dispute resolution"],
        outcomes: ["Damage documented", "Fair assessment completed", "Insurance claim initiated"],
      },
      {
        id: "travel_concierge",
        name: "AI Travel Concierge",
        description: "Enhanced customer experience with local recommendations and travel support",
        category: "upsell_cross_sell",
        script: `Hi [CUSTOMER_NAME]! I see you're picking up your [VEHICLE_TYPE] for a trip to [DESTINATION]. How exciting!

Since I know the area well, I can help make your trip even better:
- Recommended scenic routes and attractions
- GPS setup for optimal travel times
- Local dining and entertainment suggestions
- Fuel-efficient driving tips for your vehicle

Would you also like me to add our premium roadside assistance for complete peace of mind during your travels?`,
        triggers: ["Vehicle pickup", "Travel destination identified", "Cross-sell opportunities"],
        outcomes: ["Premium services added", "Customer satisfaction increased", "Local recommendations provided"],
      },
    ],
    automationOpportunities: [
      {
        process: "Insurance and Upgrade Sales",
        currentMethod: "Counter staff upselling with inconsistent results",
        automatedSolution: "AI-driven personalized insurance consultation based on travel plans and risk assessment",
        timeSavings: "5 hours per day in customer education",
        costSavings: "$3,000/month in counter staff time",
        roiImprovement: "60% increase in insurance acceptance rate = $18,000 additional monthly revenue",
      },
      {
        process: "Vehicle Return and Inspection Process",
        currentMethod: "Manual inspection with customer waiting and potential disputes",
        automatedSolution: "Guided self-inspection with photo documentation and automated damage assessment",
        timeSavings: "15 minutes per return × 200 returns/day = 50 hours/week",
        costSavings: "$5,000/month in inspection labor",
        roiImprovement: "40% faster turnaround = 25% more daily rentals",
      },
    ],
    roiMetrics: {
      callVolumeIncrease: "180% more reservation inquiries handled",
      conversionImprovement: "65% inquiry-to-rental conversion",
      costReduction: "45% reduction in customer service calls",
      revenueGrowth: "$25,000-40,000 monthly increase",
      timeToValue: "1 week with immediate reservation improvements",
    },
    pricingModel: {
      starterTier:      { monthly: 499,  callLimit: 2000,        features: ["Reservation system", "Availability tracking", "Customer support"] },
      professionalTier: { monthly: 999,  callLimit: 5000,        features: ["Insurance consultation", "Damage documentation", "Upgrade recommendations"] },
      enterpriseTier:   { monthly: 1999, callLimit: "Unlimited", features: ["Fleet optimization", "Multi-location management", "Corporate accounts"] },
    },
    seasonalPatterns: {
      peakSeasons: ["Summer vacation (June-August)", "Holiday travel (December, March)"],
      strategies: {
        "June-August":    "Maximum capacity utilization with dynamic pricing and waitlist management",
        "December/March": "Holiday premium services and family vehicle prioritization",
        "Off-peak":       "Long-term rental promotions and loyalty program engagement",
      },
    },
  },

  // ========================================================================
  // SPECIALIZED RETAIL
  // ========================================================================
  {
    industryCode: "GUN_SHOPS",
    industryName: "Firearms Dealers",
    industryCategory: "Specialized Retail",
    naicsCode: "459210",
    description: "Licensed firearms dealers, gun stores, and shooting sports retailers",
    targetAudience: ["Licensed gun dealers", "Sporting goods stores with firearms", "Shooting ranges with retail", "Firearms training facilities"],
    painPoints: {
      primary: ["Complex federal compliance requirements", "Background check coordination", "Sensitive customer conversations"],
      secondary: ["Inventory tracking for regulated items", "Training and safety education", "Insurance and liability concerns"],
      hidden: ["Community relations management", "Political climate sensitivity", "Specialized customer education needs"],
    },
    valuePropositions: {
      immediate: ["Ensure 100% compliance with federal regulations", "Streamline background check process", "Professional customer education"],
      longTerm: ["Build community trust and safety reputation", "Expand training and education services", "Reduce compliance risks"],
      competitive: ["ATF-compliant communication protocols", "Safety-first customer education", "Responsible ownership advocacy"],
    },
    features: {
      essential: ["Compliance verification", "Background check coordination", "Safety education"],
      premium: ["Training program management", "Inventory compliance tracking", "Customer education systems"],
      enterprise: ["Multi-location compliance management", "Advanced regulatory reporting", "Community outreach coordination"],
    },
    templates: [
      {
        id: "firearms_compliance_intake",
        name: "Compliance-First Customer Intake",
        description: "Thorough customer intake ensuring all legal requirements and safety protocols",
        category: "compliance",
        script: `Welcome to [STORE_NAME]. Safety and legal compliance are our top priorities.

To ensure we provide proper service:
1. Are you 18+ for long guns or 21+ for handguns?
2. Are you a resident of [STATE]?
3. Do you have valid government-issued ID?
4. Have you completed a firearms safety course?

I'll guide you through our process step-by-step, ensuring everything is handled legally and safely. Our goal is responsible ownership and community safety.`,
        triggers: ["New customer inquiry", "Firearms purchase interest", "Compliance verification"],
        outcomes: ["Compliance verified", "Safety education scheduled", "Purchase process initiated"],
      },
      {
        id: "background_check_coordination",
        name: "Background Check Process Management",
        description: "Streamlined ATF background check coordination with transparent communication",
        category: "compliance",
        script: `I'll help you through the background check process required for your purchase.

Here's what happens next:
1. Complete ATF Form 4473 accurately
2. NICS background check (typically 2-5 minutes)
3. Results: Proceed, Delay, or Deny

If delayed, this is normal and often resolves within 3 business days. I'll keep you updated on status and next steps. Do you have any questions about this federally required process?`,
        triggers: ["Background check required", "Process explanation needed", "Status update requests"],
        outcomes: ["Form 4473 completed", "Background check initiated", "Customer educated on process"],
      },
      {
        id: "safety_training_promotion",
        name: "Safety Education & Training Programs",
        description: "Comprehensive safety training promotion with responsible ownership emphasis",
        category: "upsell_cross_sell",
        script: `Congratulations on your purchase! Now let's talk about the most important part - safe and responsible ownership.

We offer several training programs:
1. Basic firearms safety course
2. Concealed carry permit classes
3. Advanced marksmanship training
4. Home defense strategies

Which level matches your experience and goals? Proper training isn't just recommended - it's essential for you, your family, and our community's safety.`,
        triggers: ["Post-purchase", "New firearm owner", "Training interest"],
        outcomes: ["Training course scheduled", "Safety materials provided", "Ongoing education relationship established"],
      },
    ],
    automationOpportunities: [
      {
        process: "ATF Compliance Documentation and Tracking",
        currentMethod: "Manual paperwork with high error rates and compliance risks",
        automatedSolution: "Automated compliance verification with real-time ATF regulation updates",
        timeSavings: "3 hours per day in paperwork and verification",
        costSavings: "$2,400/month in compliance administration",
        roiImprovement: "99.9% compliance accuracy prevents $50,000+ in potential violations and license risks",
      },
      {
        process: "Customer Education and Safety Training Coordination",
        currentMethod: "Ad-hoc safety conversations with inconsistent messaging",
        automatedSolution: "Systematic safety education with standardized protocols and follow-up",
        timeSavings: "2 hours per day in customer education",
        costSavings: "$1,600/month in education time",
        roiImprovement: "300% increase in training program enrollment = $6,000 additional monthly revenue",
      },
    ],
    roiMetrics: {
      callVolumeIncrease: "120% more inquiries handled with proper screening",
      conversionImprovement: "40% qualified inquiry-to-purchase conversion",
      costReduction: "50% reduction in compliance administration time",
      revenueGrowth: "$12,000-20,000 monthly increase",
      timeToValue: "2 weeks with immediate compliance improvements",
    },
    pricingModel: {
      starterTier:      { monthly: 399,  callLimit: 800,         features: ["Basic compliance", "Customer screening", "Safety education"] },
      professionalTier: { monthly: 799,  callLimit: 2000,        features: ["Advanced compliance tracking", "Training coordination", "Inventory management"] },
      enterpriseTier:   { monthly: 1599, callLimit: "Unlimited", features: ["Multi-location compliance", "Regulatory reporting", "Community program management"] },
    },
    complianceRequirements: {
      regulations: ["ATF Federal Firearms License requirements", "NICS background check compliance", "State and local firearms laws"],
      certifications: ["FFL compliance", "State dealer licensing", "Zoning compliance"],
      dataProtection: ["ATF Form 4473 security", "Customer information protection", "Audit trail maintenance"],
      industryStandards: ["NSSF best practices", "Responsible retail standards", "Community safety protocols"],
    },
  },
];

// O(1) lookup for code -> template. Codes are case-normalised on insert
// and on read (route does .toUpperCase()).
export const INDUSTRY_BY_CODE: Map<string, IndustryTemplate> = new Map(
  REVOLUTIONARY_INDUSTRIES.map((i) => [i.industryCode, i] as const),
);

export function getIndustryByCode(code: string): IndustryTemplate | undefined {
  return INDUSTRY_BY_CODE.get(String(code || "").toUpperCase());
}
