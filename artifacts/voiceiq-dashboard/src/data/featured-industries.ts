// /src/data/featured-industries.ts
//
// Single source of truth for all industry-specific landing pages at /for/<slug>.
// Adding a new industry: append an entry here; the route + page render automatically.
//
// Categories drive the megamenu grouping in LandingNav.
// Featured flag controls whether industry appears on the IndustriesHubPage's
// hero strip (vs. the full grid below the fold).

export type IndustryCategory =
  | "home-services"
  | "professional-services"
  | "hospitality-lifestyle"
  | "auto-transport"
  | "health-wellness";

export const CATEGORY_LABELS: Record<IndustryCategory, string> = {
  "home-services": "Home Services",
  "professional-services": "Professional Services",
  "hospitality-lifestyle": "Hospitality & Lifestyle",
  "auto-transport": "Auto & Transport",
  "health-wellness": "Health & Wellness",
};

export const CATEGORY_ORDER: IndustryCategory[] = [
  "home-services",
  "professional-services",
  "hospitality-lifestyle",
  "auto-transport",
  "health-wellness",
];

export interface TranscriptTurn {
  speaker: "Neverr" | "Caller" | "System";
  text: string;
}

export interface IndustryBrief {
  slug: string; // route segment: /for/<slug>
  name: string; // display name: "Plumbers"
  category: IndustryCategory;
  emoji: string; // lightweight icon used in megamenu + hub
  featured: boolean; // appears on IndustriesHubPage hero strip
  shortPitch: string; // 1-line pitch shown in megamenu hover + hub card

  hero: {
    headline: string;
    subhead: string;
    ctaPrimary: string;
    ctaSecondary: string;
  };

  pain: { title: string; body: string }[]; // exactly 3

  proof: {
    title: string;
    setup: string; // 1-2 sentence setup before the transcript
    transcript: TranscriptTurn[];
    durationLabel: string; // e.g. "2:34" or "Duration: 2:34"
    handoffMarkers: string[]; // the ✓ checkmark lines after [CALL ENDS]
    caption: string; // post-transcript explanation of what was demonstrated
  };

  howItWorks: { step: string; title: string; body: string }[]; // 3 steps

  whatItHandles: string[]; // bullet list

  beyondTheCall: {
    headline: string;
    subhead: string;
    blocks: { title: string; body: string }[]; // 4 blocks
  };

  whyNeverr: {
    headline: string;
    blocks: { title: string; body: string }[]; // 3-4 blocks
  };

  integrations: {
    headline: string;
    body: string; // the locked Zapier+webhook language, lightly customized
    examples: string[]; // example vendor names (positioned as Zapier-compatible)
  };

  close: {
    headline: string;
    subhead: string;
    ctaPrimary: string;
    ctaSecondary: string;
  };

  seo: {
    title: string;
    description: string;
  };
}

// ============================================================================
// LOCKED INTEGRATION COPY (per Path B β decision — 2026-05-04)
// ============================================================================
// All 17 industries use this body text with light vertical-specific phrasing.
// DO NOT add named-vendor "native" claims. We integrate via Zapier + webhooks
// only; native vendor integrations are roadmap, not shipped (per verified
// feature ledger, 2026-05-04).

const STANDARD_INTEGRATION_BODY = (verticalLabel: string) =>
  `Neverr connects to your existing systems via Google Calendar and Microsoft Outlook for native two-way calendar sync, Zapier for 5,000+ apps (including most ${verticalLabel} via Zapier connectors), and custom webhooks (Pro plan and above) for direct integration with any system that accepts incoming HTTP. Native integrations with the major ${verticalLabel} are on our roadmap — for now, the Zapier path covers the workflows our customers actually run.`;

// ============================================================================
// INDUSTRY DATA — 17 verticals
// ============================================================================

export const INDUSTRIES: IndustryBrief[] = [
  // ==========================================================================
  // HOME SERVICES (4)
  // ==========================================================================
  {
    slug: "plumbers",
    name: "Plumbers",
    category: "home-services",
    emoji: "🔧",
    featured: true,
    shortPitch: "Triage emergencies, dispatch the right tech, sync to your FSM.",
    hero: {
      headline: "Never miss another emergency dispatch.",
      subhead:
        "Neverr is the AI receptionist trained for plumbing. It triages emergencies in the first 20 seconds, dispatches the right tech, applies after-hours pricing automatically, and syncs jobs to your FSM — sub-second answer, bilingual native.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it dispatches a burst pipe",
    },
    pain: [
      {
        title: "It can't tell a slow drain from a sewage backup.",
        body: "Generic AI hears 'water issue' and books Tuesday. The slow drain is a Tuesday booking. The sewage backup is a tonight emergency at after-hours pricing. Neverr asks the questions an experienced dispatcher would and triages correctly before the truck rolls.",
      },
      {
        title: "It dispatches the wrong tech for the job.",
        body: "A water heater install isn't the same job as a drain clean. Generic AI books 'plumber needed' and your senior tech rolls up to a 30-minute drain clear while a 4-hour heater install sits unassigned. Neverr knows the call type and dispatches the tech who can actually do the work.",
      },
      {
        title: "It can't trade off speed for accuracy.",
        body: "Generic AI optimizes for 'answer fast and capture a name.' Wrong instinct for plumbing. The customer with a flooded basement doesn't need fast — they need the right four questions before the truck rolls. Neverr asks them, in the order a senior dispatcher would.",
      },
    ],
    proof: {
      title: "Watch Neverr dispatch a burst pipe at 11:47 PM.",
      setup:
        "Tuesday, 11:47 PM. Customer's pipe burst in the basement. Existing customer, recognized by phone number lookup.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Eastside Plumbing, this is the after-hours line. How can I help?",
        },
        {
          speaker: "Caller",
          text: "Hi, my pipe just burst in my basement — water's everywhere. I shut the main off but it's still spraying.",
        },
        {
          speaker: "Neverr",
          text: "Okay — first thing, you did the right thing shutting the main. Are you and everyone in the house safe and out of the water?",
        },
        { speaker: "Caller", text: "Yeah, we're upstairs. The basement is finished, there's about 2 inches down there." },
        {
          speaker: "Neverr",
          text: "Got it. The fact that it's still spraying with the main off means it's likely between the main and your water heater — probably a fitting on the cold side. I'm dispatching Marco — he's our after-hours emergency tech and he handles pipe failures. He can be at your address in 35 minutes. Our after-hours rate is a $189 callout fee plus standard time-and-materials. Does that work?",
        },
        { speaker: "Caller", text: "Yes, please send him." },
        {
          speaker: "Neverr",
          text: "Marco is dispatched. While you wait, do you have a wet-vac you can start on the standing water? Even pulling the worst of it will help with damage. And keep the main off until Marco confirms it's safe to turn back on.",
        },
        { speaker: "Caller", text: "Okay, I have one in the garage." },
        {
          speaker: "Neverr",
          text: "Perfect. You'll get a text in 2 minutes with Marco's photo, his ETA, and a live tracking link so you can see when he's pulling up. He'll call you when he's 5 minutes out.",
        },
      ],
      durationLabel: "Duration: 2:34",
      handoffMarkers: [
        "DISPATCHED — Marco Reyes, Truck 6 (after-hours emergency cert), ETA 12:22 AM",
        "Synced to ServiceTitan via Zapier as Job #14782",
        "After-hours rate applied: $189 callout + standard T&M",
        "Customer texted: tech name, photo, ETA, live tracking",
        "Pre-arrival instruction: keep main off, wet-vac standing water",
      ],
      caption:
        "Two minutes, thirty-four seconds. One pipe burst, triaged correctly, after-hours emergency tech dispatched with full diagnostic context, after-hours pricing communicated upfront, ServiceTitan synced via Zapier — all before midnight.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your shop (~5 minutes)",
        body: "Pick 'Plumbing' — we pre-load the playbook. Add your service area, trucks, tech specializations, after-hours rules, emergency triage protocols. Connect your FSM via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number — or get a fresh one. Sub-second answer. Emergency triage in the first 20 seconds. Dispatch synced to your FSM. Customer texted with tech ETA and tracking.",
      },
    ],
    whatItHandles: [
      "Emergency triage — burst pipes, sewage backup, no hot water in winter, gas-smell calls (route immediately)",
      "Routine service booking — drain clearing, fixture install, water heater service, leak repair",
      "Service area filtering — automatic referral or polite decline for jobs outside your zone",
      "After-hours dispatch with after-hours pricing applied automatically",
      "Maintenance plan member recognition — phone-number lookup identifies club members on connect",
      "Bilingual handling — English and Spanish from day one",
      "Spam filtering — extended-warranty calls, robocalls, lead-gen scrapers killed silently",
      "Live transfer — anything outside scope transfers to your team with full context",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Answering the phone is the start. The platform behind it is what compounds the revenue.",
      blocks: [
        {
          title: "Recover the customers who haven't called in a year.",
          body: "Most plumbing shops have hundreds of contacts who haven't called since their last service — water heater, drain cleaning, leak repair. Neverr's recovery campaigns automatically re-engage dormant contacts via SMS at the right time of year (water heater 8-12 years post-install, sump pump pre-spring), with templates you can edit. Each recovered job is found revenue, not new acquisition cost.",
        },
        {
          title: "Catch the call you missed before they call the next shop.",
          body: "When a call comes in that Neverr can't get to — outage, peak surge, edge case — automatic missed-call text-back fires within seconds. 'Hi, this is Eastside Plumbing. We just missed your call — what's going on?' The customer responds on their phone instead of dialing the next number on Google.",
        },
        {
          title: "See your call-to-job conversion by source.",
          body: "The analytics dashboard shows where your jobs come from — Google Ads, Yelp, referrals, repeat — and where the leaks are. Period-over-period comparisons let you see whether last month's $4,000 ad spend converted at 18% or 31%. The benchmark report compares your conversion rate to other plumbing shops on the platform.",
        },
        {
          title: "Recognize VIP customers the moment they call.",
          body: "Caller profiles flag your top customers — frequent callers, large-job history, commercial accounts — so the AI greets them differently and routes them to your senior tech directly. The contact who's spent $18,000 with you across three jobs doesn't sit through generic intake.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for plumbing. Priced to make sense.",
      blocks: [
        {
          title: "Trained on plumbing. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'home services' landing page. They answer your phone, but they don't know that 'slow drain' is routine and 'sewage backing up' is an emergency. Neverr is trained specifically on plumbing call patterns, vocabulary, and triage logic. The AI knows the difference between a trip charge and a callout fee. It dispatches the right tech for the call type — not the next available truck.",
        },
        {
          title: "Predictable pricing, no peak-season surprises.",
          body: "The plumbing answering service market is full of pricing traps: per-minute plans punish chatty homeowners, per-call plans punish emergency surges, per-customer plans punish your marketing campaigns, tier-locked features advertise $49 but lock everything that matters behind $149+. Neverr is flat-rate. Your bill in July looks like your bill in November.",
        },
        {
          title: "Plugs into your existing phone system. No vendor switch.",
          body: "You don't have to rip out your phone system to get an AI receptionist that works. Neverr forwards from your existing line. Setup is ~5 minutes, not a 6-week migration. We integrate via Zapier or webhook with most field service systems.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the tools you already use.",
      body: STANDARD_INTEGRATION_BODY("plumbing-industry FSM tools"),
      examples: ["ServiceTitan", "Housecall Pro", "Jobber", "FieldEdge", "Workiz", "Service Fusion"],
    },
    close: {
      headline: "Stop losing $50K+/year to voicemail.",
      subhead:
        "74% of calls go unanswered industry-wide. Each one is a $350 immediate job and $50K+ lifetime customer walking to the next shop. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Plumbers — AI Receptionist for Emergency Dispatch",
      description:
        "Plumbing-trained AI receptionist with emergency triage, after-hours dispatch, and FSM integration via Zapier. Sub-second answer. Try free for 7 days.",
    },
  },

  {
    slug: "hvac-companies",
    name: "HVAC Companies",
    category: "home-services",
    emoji: "❄️",
    featured: true,
    shortPitch: "Equipment-aware intake, recognize members, no peak-season surcharges.",
    hero: {
      headline: "Never miss another no-cool call in July.",
      subhead:
        "Neverr is the AI receptionist trained for HVAC. It triages equipment-specific issues, recognizes club members instantly, dispatches the right tech with the right parts, and handles 3x peak-season call volume without surcharges.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a heat wave",
    },
    pain: [
      {
        title: "It can't triage equipment.",
        body: "'My AC isn't cooling' could be a $189 capacitor swap or a $2,400 refrigerant leak. The right diagnostic questions tell your dispatcher who to send and what to bring. Generic AI books 'AC not working' and the tech rolls up unprepared.",
      },
      {
        title: "It treats every customer as a stranger.",
        body: "Your maintenance club members pay monthly for priority dispatch and member pricing. Generic AI doesn't know who they are. They wait in queue behind one-time callers, get standard pricing, and start wondering what they're paying for.",
      },
      {
        title: "It punishes you in peak season.",
        body: "Per-minute pricing charges more for a 6-minute call than a 90-second one. Per-call pricing punishes the first heat wave when call volume triples. The pricing model that works in April becomes a tax on success in July.",
      },
    ],
    proof: {
      title: "Watch Neverr triage a no-cool call during a heat wave.",
      setup:
        "Tuesday, 2:47 PM during the first heat wave of summer. Outside temp 96°F. Existing customer (Comfort Club member, recognized via phone number lookup against your CRM).",
      transcript: [
        {
          speaker: "Neverr",
          text: "Bayside Heating & Air, this is Robert? I see you're on our Comfort Club plan — what's going on?",
        },
        {
          speaker: "Caller",
          text: "Yeah, hi. The AC just stopped cooling about an hour ago. The outside unit's running but the air coming out of the vents is room temperature.",
        },
        {
          speaker: "Neverr",
          text: "That's a classic symptom and there are a few likely causes. Real quick — your system is the 4-ton heat pump we installed in 2022, the Trane XR16, right?",
        },
        { speaker: "Caller", text: "Yes, that's the one." },
        {
          speaker: "Neverr",
          text: "Okay. Can you check the thermostat for any flashing lights or error codes? And while you're there, what's the indoor temperature reading?",
        },
        { speaker: "Caller", text: "No errors, just normal display. Indoor says 81 — set point is 72." },
        {
          speaker: "Neverr",
          text: "Got it. And one more — can you walk outside and tell me if you hear the outdoor unit's fan running, and whether the large refrigerant line going into your house feels cold or warm?",
        },
        {
          speaker: "Caller",
          text: "...the fan is running. The big line is warm. Not cold like it usually is.",
        },
        {
          speaker: "Neverr",
          text: "That points to a refrigerant or compressor issue, not a capacitor. Marco is our senior heat pump tech — he's about 40 minutes out. Because you're a Comfort Club member, you have priority dispatch and the diagnostic is covered. If repair is needed, you get the 15% member discount on parts and labor.",
        },
        { speaker: "Caller", text: "Perfect. Should I shut the system off in the meantime?" },
        {
          speaker: "Neverr",
          text: "Yes — set the thermostat to OFF, not just to a higher temperature. Running it dry can damage the compressor if there's a refrigerant issue. I'm dispatching Marco now.",
        },
      ],
      durationLabel: "Duration: 2:48",
      handoffMarkers: [
        "DISPATCHED — Marco Reyes, Truck 4 (heat pump certified), ETA 3:32 PM",
        "Synced to ServiceTitan via Zapier as Job #8821",
        "Equipment loaded: Trane XR16, 4-ton heat pump, 2022 install",
        "Suspected diagnosis: refrigerant or compressor (warm liquid line + warm vents)",
        "Maintenance plan: Comfort Club member — priority dispatch + 15% discount applied",
      ],
      caption:
        "Two minutes, forty-eight seconds. One club member, equipment recognized via CRM lookup, diagnostic class identified, heat-pump-certified tech dispatched with the right parts, member benefits applied — all before the customer hung up.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. No procurement, no implementation team.",
      },
      {
        step: "02",
        title: "Tell us about your shop (~5 minutes)",
        body: "Pick 'HVAC' — we pre-load the playbook. Add your service area, trucks and tech specializations, maintenance plan tiers, after-hours rates. Connect your FSM via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number — or get a fresh one. Equipment-aware intake. Member recognition. Dispatch synced to your FSM. Peak-season volume without per-call surcharges.",
      },
    ],
    whatItHandles: [
      "Equipment-aware intake — heat pump vs. split, gas vs. electric, brand/age/error codes/line temps",
      "Emergency triage — no-heat in winter, no-cool in summer, refrigerant leaks, electrical, gas leaks",
      "Maintenance plan member recognition — phone-number lookup identifies club members on connect",
      "Service area filtering — automatic referral for jobs outside your zone",
      "After-hours dispatch with after-hours rates applied",
      "Tune-up and seasonal scheduling (pre-season AC, fall furnace)",
      "System replacement / quote requests — captures system age, square footage, schedules sales call",
      "Spam filtering — extended-warranty calls, robocalls, lead-gen scrapers killed silently",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer — anything outside scope transfers to your team",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Peak season is when the call matters. The platform is what makes the off-season profitable.",
      blocks: [
        {
          title: "Off-season recovery campaigns to fill the slow months.",
          body: "HVAC's brutal seasonal math — 73% of revenue in 6 months — means the slow months matter disproportionately. Neverr's recovery campaigns automatically re-engage dormant contacts during shoulder season (early spring AC tune-ups, early fall furnace tune-ups) with SMS sequences targeted by last-service-date and equipment age. The result: a flatter revenue curve.",
        },
        {
          title: "Missed-call text-back during the heat wave.",
          body: "First heat wave of summer, call volume triples in 48 hours. Even with Neverr handling the inbound, edge-case overflow can happen. Missed-call text-back fires automatically — 'We just missed your call. Reply with your address and we'll text you back when our next tech is available.' The customer doesn't call your competitor.",
        },
        {
          title: "Live Call Coaching for warm transfers (Enterprise).",
          body: "When a call needs to transfer to your senior tech mid-conversation — commercial account, complex multi-system diagnosis, large replacement quote — Neverr can monitor the live call and send real-time SMS coaching tips to the tech taking the handoff. 'Customer mentioned heat pump in attic — confirm zone count before quoting.' Available on Enterprise.",
        },
        {
          title: "Industry benchmarks: how does your shop compare?",
          body: "The benchmarks dashboard compares your call answer rate, call-to-job conversion, average ticket size, and maintenance plan attach rate to other HVAC shops on the platform. You'll see whether your 28% conversion is best-in-class or below average for shops your size, and where to focus.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for HVAC. Priced for peak season.",
      blocks: [
        {
          title: "Trained on HVAC. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with an 'HVAC' landing page. They don't know that 'air blowing warm' with a running outdoor unit usually means refrigerant — not a capacitor. They don't know that a heat pump in the South handles 95% of heating, while a heat pump in Minnesota is supplemental to gas. Neverr is trained on HVAC equipment classes, diagnostic questions, dispatch logic, and seasonal patterns specifically.",
        },
        {
          title: "Flat-rate pricing. No peak-season surcharges.",
          body: "The HVAC answering service market is full of pricing models that punish you in summer: per-minute plans, per-call plans, per-customer plans, tier-locked features. Neverr is flat-rate. Your bill in October — when call volume peaks — looks like your bill in February.",
        },
        {
          title: "Plugs into your existing phone and FSM. No vendor switch.",
          body: "You don't have to rip out your phone system to add an AI receptionist. Neverr forwards from your existing line. Setup is ~5 minutes, not a 6-week migration. We integrate via Zapier or webhook with most HVAC field service systems.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the FSM your dispatcher already uses.",
      body: STANDARD_INTEGRATION_BODY("HVAC field service management tools"),
      examples: ["ServiceTitan", "Housecall Pro", "Jobber", "FieldEdge", "Workiz", "Service Fusion", "Successware"],
    },
    close: {
      headline: "Stop losing $100,000+ a year to peak-season missed calls.",
      subhead:
        "HVAC contractors lose 73% of their annual revenue opportunity in just six months. Try Neverr free for 7 days. No card required, no peak-season surcharges, ever.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for HVAC Companies — AI Receptionist for Equipment-Aware Dispatch",
      description:
        "HVAC-trained AI receptionist with equipment-aware intake, member recognition, and flat-rate pricing through peak season. Integrates with ServiceTitan, Housecall Pro, Jobber via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "auto-repair-shops",
    name: "Auto Repair Shops",
    category: "auto-transport",
    emoji: "🔩",
    featured: true,
    shortPitch: "Vehicle-aware intake, responsible estimates, shop management sync.",
    hero: {
      headline: "Never lose another customer to the next shop on Google.",
      subhead:
        "Neverr is the AI receptionist trained for auto repair. It captures year/make/model/mileage, structures symptom intake, gives responsible estimate ranges, and books directly into your shop management software — before your service writer can pick up the second line.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a brake call",
    },
    pain: [
      {
        title: "It can't capture vehicle data correctly.",
        body: "Year, make, model, mileage, symptoms, warning lights, when it started. Five data points that determine which tech, which parts, which lift, which bay slot. Generic AI logs 'car making noise' and your service writer plays detective when the customer arrives.",
      },
      {
        title: "It either gives wrong estimates or refuses to give estimates.",
        body: "Neither works. Customers price-shop. The shop that gives an honest range — anchored to common parts and caveated on tech inspection — wins the appointment. Generic AI either fabricates pricing or punts to 'the technician will tell you,' which sends the caller to the next shop on the list.",
      },
      {
        title: "It treats every shop the same.",
        body: "A 3-bay independent and a 15-bay multi-location chain don't operate the same way. Generic AI uses the same voice for both, the same triage logic, the same estimate protocol. Yours doesn't fit.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a Monday-morning brake call.",
      setup: "Monday, 8:23 AM, peak service-writer rush. Customer's brakes started grinding over the weekend.",
      transcript: [
        { speaker: "Neverr", text: "Eastside Auto Repair, this is the service line. How can I help?" },
        {
          speaker: "Caller",
          text: "Yeah hi, my brakes are making this awful grinding sound. Started Saturday, getting worse. Can you look at it today?",
        },
        {
          speaker: "Neverr",
          text: "Grinding usually means it's time to address it soon — let me get you in. Quick questions to make sure we have the right tech and parts ready. What's the year, make, and model?",
        },
        { speaker: "Caller", text: "2018 Toyota Camry. SE." },
        { speaker: "Neverr", text: "Got it, 2018 Camry SE. About how many miles on it?" },
        { speaker: "Caller", text: "Around 87,000." },
        { speaker: "Neverr", text: "And the grinding — is it constant, or only when you press the brake?" },
        { speaker: "Caller", text: "Only when I brake. And it's worse when I'm coming to a full stop." },
        { speaker: "Neverr", text: "Front of the car, back of the car, or hard to tell?" },
        { speaker: "Caller", text: "Feels like the front. Driver side maybe." },
        {
          speaker: "Neverr",
          text: "Last one — when you brake hard, is the steering wheel or the brake pedal pulsing or shaking at all?",
        },
        { speaker: "Caller", text: "Yeah, the pedal feels weird. Kind of vibrates." },
        {
          speaker: "Neverr",
          text: "That's helpful. Grinding plus pedal pulsation usually means the front pads are worn down to the metal and the rotors have started to score. Marcus is our brake-and-suspension lead. I want to be straight with you: we won't know exact pricing until Marcus inspects, but for a 2018 Camry, front pads and rotors typically runs $380 to $520 with our standard parts. The diagnostic inspection itself is complimentary.",
        },
        { speaker: "Caller", text: "Okay, that's reasonable. Can you do it today?" },
        {
          speaker: "Neverr",
          text: "We have a 1:30 PM slot today with Marcus. The job typically takes about 90 minutes. We have a shuttle that can take you home or to work in our service area. Any preference?",
        },
        { speaker: "Caller", text: "Shuttle would be great. I work downtown." },
      ],
      durationLabel: "Duration: 2:38",
      handoffMarkers: [
        "NEW APPOINTMENT in shop management software — David Chen, 1:30 PM Monday",
        "Vehicle: 2018 Toyota Camry SE, 87,000 mi",
        "Symptoms captured: grinding (worse at full stop), front brake, pedal pulsation",
        "Probable diagnosis: front pads + rotors (possibly calipers)",
        "Estimate range communicated: $380-$520, diagnostic complimentary",
        "Tech assigned: Marcus (brake/suspension lead)",
        "Shuttle booked: downtown drop after vehicle drop-off",
      ],
      caption:
        "Two minutes, thirty-eight seconds. Vehicle data captured, symptoms triaged, probable cause identified, estimate range communicated, tech assigned, bay reserved, shuttle booked, shop management software synced — all before the service writer finishes the customer at the counter.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number. Card optional during the 7-day trial." },
      {
        step: "02",
        title: "Tell us about your shop (~5 minutes)",
        body: "Pick 'Auto Repair' — we pre-load the playbook. Add your bays, lifts, tech specializations, common-job estimate ranges, shuttle service area, warranty and insurance shop relationships. Connect your shop management software via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number — or get a fresh one. Vehicle and symptom intake structured. Estimate ranges given responsibly. Appointments written directly to your shop management software with full intake context.",
      },
    ],
    whatItHandles: [
      "Vehicle-and-symptom intake — year/make/model/mileage/symptoms/warning lights/when-it-started",
      "Diagnostic-class identification — brake / drivetrain / electrical / AC / alignment — routes to the right tech",
      "Estimate ranges — anchored to common parts databases, always caveated to tech inspection",
      "Appointment booking — bay-aware, lift-aware, tech-specialty-aware",
      "Parts pre-flagging — common-issue parts pre-ordered or flagged",
      "Insurance referral handling — captures Geico/State Farm/Allstate referral source",
      "Warranty work intake — powertrain vs. bumper-to-bumper vs. extended (CarShield/Endurance)",
      "Shuttle / loaner / waiter coordination",
      "After-hours drop-off — provides overnight key-drop instructions",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers killed silently",
      "Bilingual handling — English and Spanish from day one",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the appointment is the start. The platform turns a one-time job into a 10-year customer.",
      blocks: [
        {
          title: "Deferred-work recovery campaigns.",
          body: "Every shop has it — the work the customer didn't approve. Brakes that have 20% pad life left, the timing belt that's 'due soon,' the alignment that 'can wait.' It almost always quietly walks away. A typical shop leaves 45% of recommended work unapproved. Neverr's recovery campaigns automatically re-engage with the right cadence, with templates that respect the original recommendation without being pushy.",
        },
        {
          title: "Missed-call text-back so cold prospects don't call the next shop.",
          body: "The cold prospect with the broken-down car opens 5 tabs and calls in order. The second they hit voicemail, they're gone. Even when Neverr is handling the inbound, missed-call text-back is the failsafe — 'We just missed your call. What's going on?' The customer answers on their phone, not with your competitor.",
        },
        {
          title: "Caller profiles + VIP tagging for fleet and repeat customers.",
          body: "The contractor with three trucks. The Toyota family with two cars and a teenage driver. The fleet account that pays net-30. Neverr's caller profiles flag them on connect, route them to your senior service writer, and apply VIP protocols. The tier of customer a shop can't afford to mishandle gets recognized before the conversation starts.",
        },
        {
          title: "Two-way SMS conversations for status updates.",
          body: "Customers want to know when their car's done — they don't want to call the shop. Neverr handles two-way SMS: status updates, approval requests for additional work, ready-for-pickup, post-service follow-up. Job approval becomes one tap on the customer's phone.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for auto. Priced predictably. Never invents an estimate.",
      blocks: [
        {
          title: "Trained on auto repair. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with an 'auto repair' landing page. They take a message and pass it along. Neverr is trained on automotive intake — year/make/model/mileage as a structured data spine, symptom triage by diagnostic class, common-job estimate ranges from real parts databases, tech specialization routing.",
        },
        {
          title: "Estimate ranges given responsibly. Never invented.",
          body: "The fastest way to lose a customer is the wrong number. The second fastest is no number. Neverr anchors estimate ranges to your shop's common-job pricing — and always closes with 'the tech will confirm after inspection.' Customers get a useful answer for their price-shopping. You don't get a dispute when the final invoice differs from a fabricated quote.",
        },
        {
          title: "Predictable pricing. No per-minute, no per-call.",
          body: "The auto repair answering service market punishes you exactly when call volume is highest. Neverr is flat-rate. Your bill on a busy Monday looks like your bill on a slow Wednesday.",
        },
        {
          title: "Plugs into your shop management system. No vendor switch.",
          body: "You don't have to rip out Mitchell 1 or Tekmetric to add an AI receptionist. Neverr forwards from your existing line, integrates with your existing shop software via Zapier or webhook, and goes live in days, not weeks.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the shop management system you already run.",
      body: STANDARD_INTEGRATION_BODY("auto repair shop management systems"),
      examples: ["Tekmetric", "Shop-Ware", "Mitchell 1", "AutoLeap", "RO Writer", "Shopmonkey", "NAPA TRACS"],
    },
    close: {
      headline: "Stop losing customers to the next shop on Google.",
      subhead:
        "Each missed call is a $5K-$10K lifetime customer walking to a competitor. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Auto Repair Shops — AI Receptionist with Vehicle-Aware Intake",
      description:
        "Auto-trained AI receptionist that captures year/make/model/mileage, gives responsible estimates, and books directly into Tekmetric, Shop-Ware, Mitchell 1 via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "bike-shops",
    name: "Bike Shops",
    category: "auto-transport",
    emoji: "🚲",
    featured: false,
    shortPitch: "Service intake, e-bike triage, parts availability, seasonal rush absorption.",
    hero: {
      headline: "Never miss another tune-up call during spring rush.",
      subhead:
        "Neverr is the AI receptionist trained for bike shops. It captures bike make/model/symptom intake, checks part availability against your typical inventory, books service appointments with the right mechanic, and handles the e-bike battery questions your front-of-house can't answer mid-rush.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles an e-bike service call",
    },
    pain: [
      {
        title: "It can't capture service intake correctly.",
        body: "Bike make/model/year, drivetrain (Shimano vs. SRAM, generation, speed count), wheel size, tire type, e-bike specifics — these determine which mechanic, which tools, which parts. Generic AI logs 'bike making noise' and your shop manager plays detective.",
      },
      {
        title: "It can't tell apart a $40 brake adjust from a $400 e-bike service.",
        body: "Service tickets vary 10x. Generic AI books 'appointment' and your shop discovers Monday morning that the 30-minute slot is actually a 4-hour Bosch battery diagnostic.",
      },
      {
        title: "Spring rush is a cliff, not a curve.",
        body: "First warm Saturday in March, your phone rings 60 times. Your two front-of-house staff can't keep up. Calls roll, customers go to the next shop on Google, the seasonal revenue you depend on leaks.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a Saturday e-bike service call.",
      setup: "Saturday, 11:34 AM. Customer with a 2023 Specialized Vado e-bike — battery range dropped, occasional power cut.",
      transcript: [
        { speaker: "Neverr", text: "Velocity Bike Shop, this is the service line. How can I help?" },
        {
          speaker: "Caller",
          text: "Hi, my e-bike is having issues. The battery range has dropped a lot and sometimes the power cuts out while I'm riding.",
        },
        {
          speaker: "Neverr",
          text: "Let me get the right mechanic on this. What's the make, model, and year?",
        },
        { speaker: "Caller", text: "It's a 2023 Specialized Vado, the 4.0." },
        {
          speaker: "Neverr",
          text: "Got it — Bosch motor system. About how many miles on it, and when did the issues start?",
        },
        { speaker: "Caller", text: "Around 1,800 miles. Started about two weeks ago, getting worse." },
        {
          speaker: "Neverr",
          text: "Are you charging the battery the same way you always have, and how long has it been since the last full charge cycle?",
        },
        { speaker: "Caller", text: "Same wall charger, charged it last night. Display says 100% but range is way off." },
        {
          speaker: "Neverr",
          text: "Any error codes on the display when the power cuts out?",
        },
        { speaker: "Caller", text: "Yeah, sometimes I see a wrench icon and a number. I think it was 504 last time." },
        {
          speaker: "Neverr",
          text: "504 on a Bosch system points to a battery cell or controller issue, not the motor itself. We'll want to run a Bosch diagnostic — Marcus is our e-bike-certified mechanic. Diagnostic is $89; if it's a battery cell issue we'd be looking at a battery service in the $200-400 range, or controller work in the $150-300 range. We won't know exact until Marcus runs the test. Tuesday at 10 AM works for him — that good?",
        },
        { speaker: "Caller", text: "Yes, perfect." },
      ],
      durationLabel: "Duration: 2:51",
      handoffMarkers: [
        "NEW SERVICE APPOINTMENT in shop POS — Sarah Liu, Tuesday 10 AM",
        "Bike: 2023 Specialized Vado 4.0, ~1,800 miles, Bosch motor system",
        "Symptoms: range drop, intermittent power cut, error code 504",
        "Probable diagnosis: battery cell or controller (NOT motor)",
        "Tech assigned: Marcus (e-bike certified)",
        "Estimate ranges communicated: $89 diag + $200-400 battery OR $150-300 controller",
        "Bosch diagnostic kit pre-flagged for Tuesday",
      ],
      caption:
        "Two minutes, fifty-one seconds. E-bike triage by motor system, error code interpreted, diagnostic class identified, e-bike-certified mechanic booked, estimate ranges communicated honestly, parts pre-flagged.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number." },
      {
        step: "02",
        title: "Tell us about your shop (~5 minutes)",
        body: "Pick 'Bike Shop' — we pre-load the playbook. Add your bike specializations (road, mountain, gravel, e-bike, BMX, kids), mechanic specialties, service menu with realistic time blocks, parts availability rules, seasonal rush pricing. Connect your POS via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number — or get a fresh one. Live answer, structured service intake, POS sync via Zapier.",
      },
    ],
    whatItHandles: [
      "Service intake with bike-specific structured questions (make/model/year/drivetrain/wheels/symptoms)",
      "E-bike triage (motor brand, battery, controller, firmware) routing to certified mechanic",
      "Estimate ranges (anchored to your service menu, always caveated to in-shop inspection)",
      "Service appointment booking with bay/mechanic awareness",
      "Parts availability quick-check (in-stock vs. order-required)",
      "Custom build inquiries → routed to sales mechanic with structured intake",
      "Holiday assembly bookings (November-December rush)",
      "Test ride scheduling",
      "Trade-in inquiries",
      "Bilingual (English/Spanish) from day one",
      "Live transfer for complex builds, warranty claims, manufacturer issues",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the service is the start. The platform brings riders back, captures upsells, and recognizes repeat customers.",
      blocks: [
        {
          title: "Recovery campaigns for service-overdue customers.",
          body: "Every shop has hundreds of past customers who haven't been in for a tune-up in 12+ months. Neverr's recovery campaigns automatically re-engage by service type and last-visit ('Your annual tune-up is due — Saturday slots open'), segmented by bike type. E-bike battery health checks especially — riders often don't know to come in until something fails.",
        },
        {
          title: "Seasonal rush capacity management.",
          body: "Spring rush triples your service intake volume in 2-3 weeks. Neverr handles the volume without your shop adding labor; surfaces overflow in your dashboard with realistic timing communicated to customers ('we're 2 weeks out for non-emergency tune-ups; here's the soonest slot'). Manages customer expectations honestly without losing the booking.",
        },
        {
          title: "Customer profiles that recognize repeat riders.",
          body: "The road cyclist who's bought 3 bikes from you. The family with 4 commuter bikes. The e-bike commuter on her second battery. Neverr recognizes them, surfaces their bike profiles, applies any VIP/club pricing, and gets them on the schedule fast.",
        },
        {
          title: "Two-way SMS for service status updates.",
          body: "'Your bike is ready' texts. 'Found additional issue, need approval' with photo attachments. 'Parts arrived — bringing your bike forward' texts. The customer experience that turns one-time service customers into shop-loyal riders.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for cycling. Priced predictably.",
      blocks: [
        {
          title: "Trained on bicycles. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools. Neverr is trained on bike-specific intake — drivetrain identification, e-bike system triage, parts availability checks, and service-specific timing.",
        },
        {
          title: "Flat-rate. No per-call surcharges during spring rush.",
          body: "Most AI receptionist pricing punishes you exactly when call volume triples. Neverr is flat-rate.",
        },
        {
          title: "Plugs into your existing POS. No vendor switch.",
          body: "Lightspeed Retail, Lightspeed Cycle, Ascend, Workstand — Neverr integrates via Zapier or webhook with most bike shop POS systems.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the POS your shop already runs.",
      body: STANDARD_INTEGRATION_BODY("bike shop POS systems"),
      examples: ["Lightspeed Retail", "Lightspeed Cycle", "Ascend", "Workstand", "ROL", "SmartEtailing"],
    },
    close: {
      headline: "Stop losing your spring rush to the next shop on Google.",
      subhead: "7-day free trial, structured service intake from call one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Bike Shops — AI Receptionist with E-Bike Service Triage",
      description:
        "Bike shop-trained AI receptionist with structured service intake, e-bike triage, parts availability, and seasonal rush handling. Try free for 7 days.",
    },
  },

  // ==========================================================================
  // HEALTH & WELLNESS (3): Dental, Veterinary, Med Spas
  // ==========================================================================
  {
    slug: "dental-practices",
    name: "Dental Practices",
    category: "health-wellness",
    emoji: "🦷",
    featured: true,
    shortPitch: "PMS-aware booking, insurance triage, HIPAA + signed BAA from day one.",
    hero: {
      headline: "Never miss another new-patient call.",
      subhead:
        "Neverr is the AI receptionist trained for dentistry. It answers every call 24/7, books directly into your PMS, verifies insurance, and triages emergencies — without breaking your block schedule.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it books an emergency",
    },
    pain: [
      {
        title: "It books into the wrong slot.",
        body: "A crown prep needs 90 minutes in an operatory with a doctor. A hygiene recall is 60 minutes in a hygiene chair. Generic AI books both as 'appointment' and your dispatcher discovers the conflict at 8 AM Monday — when it's too late to call the patient.",
      },
      {
        title: "It can't read your PMS.",
        body: "Most 'AI for dental' tools read the schedule but don't write back. New patient charts get created manually after the call. Insurance fields stay empty. Your front desk re-keys everything, defeating the point.",
      },
      {
        title: "It treats every call as if every call is the same.",
        body: "The new patient with throbbing pain at 8 PM is not the recall reminder for Mrs. Patterson. The hygienist running 20 minutes behind isn't the same as the cancellation that just opened a $3,000 chair time slot. Generic AI doesn't know the difference.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a real after-hours new patient call.",
      setup: "Tuesday, 7:34 PM. Practice closed at 5pm. Caller is a new patient with tooth pain.",
      transcript: [
        { speaker: "Neverr", text: "Sunset Dental, this is the after-hours line. How can I help?" },
        {
          speaker: "Caller",
          text: "Hi, my tooth has been killing me since this morning. I've never been to your office before — do you have anything tomorrow?",
        },
        {
          speaker: "Neverr",
          text: "I'm sorry you're in pain — let's get you in. Can you tell me on a scale of 1 to 10 how bad the pain is, and is it a sharp pain when you bite down or more of a constant throb?",
        },
        { speaker: "Caller", text: "It's like an 8. Constant throb. The whole side of my face hurts now." },
        {
          speaker: "Neverr",
          text: "That sounds like it could need urgent attention — possibly an abscess or a deep cavity. I'm going to flag this for Dr. Patel to see first thing tomorrow. We have an emergency slot at 8:15 AM with him in Operatory 1. That's a 45-minute exam plus any immediate treatment we can do same-day. Does 8:15 work?",
        },
        { speaker: "Caller", text: "Yes please. Do I need to bring anything?" },
        {
          speaker: "Neverr",
          text: "Just your insurance card if you have one, and a photo ID. Speaking of insurance — what's your plan?",
        },
        { speaker: "Caller", text: "Delta Dental PPO." },
        {
          speaker: "Neverr",
          text: "We're in-network with Delta PPO. I'll have our team verify your coverage tonight so we know your out-of-pocket before you arrive. The new-patient exam plus X-rays is typically $185 if we're billing insurance, but Delta usually covers most of that for in-network. Dr. Patel will quote any treatment after he sees you.",
        },
        { speaker: "Caller", text: "Okay. What if I need a root canal or something tomorrow?" },
        {
          speaker: "Neverr",
          text: "Dr. Patel can do same-day pain relief — he'll either start the root canal himself or refer you to our endodontist down the hall. Either way, you won't leave in pain. Can I get your name and date of birth to create your chart?",
        },
        { speaker: "Caller", text: "Maria Chen, 4-12-1987." },
      ],
      durationLabel: "Duration: 2:51",
      handoffMarkers: [
        "NEW PATIENT CHART CREATED — Maria Chen, DOB 4/12/1987",
        "APPOINTMENT BOOKED — Tuesday 11/05, 8:15 AM, Dr. Patel, Operatory 1",
        "APPOINTMENT TYPE — NP Emergency Exam (45 min, $185 standard fee)",
        "Insurance flagged for verification — Delta Dental PPO (in-network)",
        "New-patient forms texted with practice URL",
        "Synced to PMS via Zapier as Patient #18472",
      ],
      caption:
        "Two minutes, fifty-one seconds. New patient in pain triaged correctly, booked into the right slot with the right doctor in the right operatory, insurance flagged for verification, chart created in your PMS, paperwork sent via text.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. We sign your BAA at signup. No procurement, no implementation team.",
      },
      {
        step: "02",
        title: "Tell us about your practice (~10 minutes)",
        body: "Pick 'Dental' — we pre-load the playbook. Connect your PMS via Zapier. Map your block schedule (operatories, providers, appointment types, durations, insurance plans you accept). Set your emergency triage rules.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number — or get a fresh one. Every call answered in under 300ms. Appointments written directly to your PMS. New-patient charts auto-created. Insurance flagged. Front desk gets the morning huddle dashboard.",
      },
    ],
    whatItHandles: [
      "New patient intake — chief complaint, insurance, contact info, chart created in your PMS",
      "Appointment booking — block-aware, operatory-aware, provider-aware",
      "Recall scheduling — overdue patients texted; falls back to phone if no text response",
      "Emergency triage — pain scale, swelling, trauma; routes to on-call provider or next-day emergency slot",
      "Insurance verification triage — captures plan; flags new-patient calls for verification",
      "Cancellation + waitlist fill — when a patient cancels, automatically reaches out to waitlisted patients",
      "Spanish-language calls — bilingual from day one",
      "Live transfer to your team for anything outside scope, with full context",
      "Spam / robocall filtering — extended-warranty and lead-gen calls killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the call is the start. The platform reduces no-shows, fills cancellations, and recovers patients you thought were gone.",
      blocks: [
        {
          title: "Recall sequences that bring patients back.",
          body: "Most practices have hundreds of patients overdue for their 6-month recall — they meant to call, life got in the way, and the front desk never had time to chase. Neverr's SMS sequences run automated multi-touch recall flows ('It's been 7 months since your last visit — Tuesday at 10 AM works for Dr. Patel'), with replies routed back into a real conversation thread.",
        },
        {
          title: "No-show reduction with confirmation flows.",
          body: "Reminder texts at 48 hours and 24 hours before the appointment, with one-tap confirm or reschedule. Unconfirmed appointments surface in your morning huddle dashboard so the front desk can call them proactively — not after the chair is already empty.",
        },
        {
          title: "Recognize returning patients before they identify themselves.",
          body: "When Mrs. Patterson calls, Neverr's caller profiles surface her chart instantly — last appointment, hygiene cycle, any flagged notes. The AI doesn't make her re-introduce herself or repeat her insurance every time.",
        },
        {
          title: "Bilingual from day one — English and Spanish.",
          body: "Spanish-speaking patients get the same intake quality, the same recall sequences, and the same emergency triage as English-speaking patients. Cultural language detection identifies preferred language on the first call and remembers it.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for dentistry. Priced predictably. Compliant from day one.",
      blocks: [
        {
          title: "Trained on dentistry. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'dental' landing page. They don't know that a crown prep can't go in a hygiene chair, or that a 'Delta PPO' patient needs different intake than a cash-pay patient. Neverr is trained specifically on dental call patterns, block scheduling, operatory assignment, and insurance triage.",
        },
        {
          title: "HIPAA, BAA, and audit logging. Standard, not add-on.",
          body: "You sign our BAA at signup. All call data is encrypted in transit and at rest. Role-based access controls and full audit logging on every patient interaction. SOC 2 in progress. This isn't optional in dental — and it's not optional with us.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "Generic AI tools charge per minute, per unique caller, or tier-lock the features that matter behind upgrades. Neverr is flat-rate. Your bill in January looks like your bill in June.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the PMS your team already uses.",
      body: STANDARD_INTEGRATION_BODY("dental practice management software"),
      examples: ["OpenDental", "Eaglesoft", "Dentrix", "Dentrix Ascend", "Denticon", "CareStack", "Curve Dental"],
    },
    close: {
      headline: "Stop losing $100,000+ a year to voicemail.",
      subhead:
        "Practices using AI receptionists capture 80%+ of previously missed calls and reduce front-desk burden by 25 hours/week. Try Neverr free for 7 days — BAA signed at signup, no card required.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Dental Practices — AI Receptionist with Real PMS Integration",
      description:
        "Dental-trained AI receptionist that books directly into your PMS via Zapier. HIPAA compliant with signed BAA. Try free for 7 days.",
    },
  },

  {
    slug: "veterinary-clinics",
    name: "Veterinary Clinics",
    category: "health-wellness",
    emoji: "🐾",
    featured: true,
    shortPitch: "Species-specific triage, emergency escalation, recall sequences.",
    hero: {
      headline: "Never lose another emergency to the 24-hour ER.",
      subhead:
        "Neverr is the AI receptionist trained for veterinary practice. It triages by species and symptom, recognizes life-threatening cases in the first 20 seconds, escalates to your on-call DVM, and books routine visits into your PIMS — all while your front desk handles the patients in front of them.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it triages a blocked cat call",
    },
    pain: [
      {
        title: "It can't tell a routine call from a life-threatening one.",
        body: "A male cat straining in the litter box is a urinary blockage — life-threatening within hours. A dog that ate something an hour ago is in the toxin window where induced vomiting still works. Generic AI hears 'my pet is sick' and books 'next available appointment' — sometimes Tuesday. By Tuesday, it's an ER case at someone else's clinic, or worse.",
      },
      {
        title: "It can't run species-and-symptom triage.",
        body: "Different species, different ages, different symptoms point to different urgency. The questions a senior CVT asks — onset, vomiting frequency, abdominal palpation, current meds, toxin exposure — are exactly the questions generic AI doesn't ask. Your front desk does it well; generic AI doesn't.",
      },
      {
        title: "It loses your after-hours clients to the local 24-hour ER.",
        body: "When a clinic without after-hours coverage refers callers to the ER, the relationship moves with the case. The ER captures the emergency revenue, the follow-up care, the next vaccine cycle, and the next patient. Voicemail isn't neutral — it actively transfers your client base to a competitor.",
      },
    ],
    proof: {
      title: "Watch Neverr triage an after-hours blocked cat.",
      setup: "Saturday, 9:47 PM. Closed at 5 PM. Existing client whose cat hasn't urinated all day.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Bayside Animal Hospital, this is Neverr — I work with the clinic. Hi Sarah. Is this about Mochi?",
        },
        {
          speaker: "Caller",
          text: "Yes — I'm really worried. He's been trying to pee all day and nothing's coming out. He keeps going to the litter box and straining and crying. He didn't eat dinner and he's hiding under the bed.",
        },
        {
          speaker: "Neverr",
          text: "Sarah, I want to be direct with you — straining to urinate with no output in a male cat is something we treat as an emergency. It can be a urinary blockage, and in male cats that becomes life-threatening within hours, not days. I'm escalating this to Dr. Reyes right now — she's on call tonight. Before I transfer, just a few quick things: When did you last see him pee normally?",
        },
        {
          speaker: "Caller",
          text: "Yesterday morning. I noticed something was off this afternoon when I saw him going in and out of the box.",
        },
        { speaker: "Neverr", text: "Has he vomited at all today?" },
        { speaker: "Caller", text: "Twice. About an hour ago." },
        { speaker: "Neverr", text: "Is he eating, drinking, or completely off both?" },
        { speaker: "Caller", text: "He hasn't eaten since lunchtime yesterday. I haven't seen him at the bowl since." },
        {
          speaker: "Neverr",
          text: "And — this matters — when you pick him up gently, does his belly feel firm or tender, or does he cry out?",
        },
        { speaker: "Caller", text: "He cried when I tried to pick him up earlier. I haven't tried again." },
        {
          speaker: "Neverr",
          text: "Sarah, that's consistent with a likely blockage. I'm connecting you to Dr. Reyes now — please don't wait. If you can, put Mochi in his carrier while I transfer. Bring him directly to the clinic; Dr. Reyes will meet you there.",
        },
      ],
      durationLabel: "Duration: 2:15",
      handoffMarkers: [
        "EMERGENCY FLAGGED — suspected FLUTD / urinary blockage, M/N DSH",
        "Patient: Mochi, 4yo male neutered DSH, weight 11.4 lb (per chart)",
        "Symptoms captured: stranguria with no output, vomiting x2, anorexia >24h, abdominal tenderness",
        "Onset: ~24h prior to call",
        "Toxin/trauma: none reported",
        "Owner instructed: bring patient in carrier to clinic; ETA ~15 min",
        "Dr. Reyes notified via priority dispatch (on-call rotation)",
        "Synced to PIMS via Zapier — emergency visit pre-created",
      ],
      caption:
        "Two minutes, fifteen seconds. Client recognition, species- and sex-specific triage, structured emergency intake, correct urgency classification, live transfer to on-call DVM with full handoff context, owner coaching, PIMS pre-creation.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. We sign your data-handling terms at signup.",
      },
      {
        step: "02",
        title: "Tell us about your hospital (~10 minutes)",
        body: "Pick 'Veterinary' — we pre-load the playbook. Add your DVMs and CVTs, on-call rotation, species mix (small animal, exotics, large animal), emergency triage protocols, local ER referral relationships, your PIMS.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Species-and-symptom triage on every call. Emergencies route to your on-call DVM. Routine visits book into your PIMS via Zapier.",
      },
    ],
    whatItHandles: [
      "Species-and-symptom triage — canine, feline, exotic, equine — different intake protocols",
      "Emergency escalation — blocked cat, GDV, toxin exposure, dystocia, HBC, severe bleeding, respiratory distress",
      "Urgent same-day — vomiting/diarrhea >24h, lethargy, off-food, suspect UTI, lameness with swelling",
      "Routine appointment booking — annual exams, vaccinations, heartworm tests, dental cleanings",
      "Recall + reminder sequences — rabies, DAPP, bordetella, lepto, heartworm, dental",
      "Refill request capture — flags chronic medications for tech callback or pharmacy fulfillment",
      "Existing patient recognition — phone-number lookup surfaces the patient chart on connect",
      "Grief and bereavement routing — euthanasia scheduling, post-loss condolence calls auto-route to human staff",
      "Bilingual handling — English and Spanish from day one",
      "Spam filtering — extended-warranty calls, lead-gen scrapers, pet insurance solicitors killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Triaging the call is the start. The platform brings patients back, fills the schedule, and keeps your client base from drifting.",
      blocks: [
        {
          title: "Recall sequences for the patients who didn't come back.",
          body: "Every clinic has hundreds of patients overdue for rabies, DAPP, heartworm, or dental. Neverr's SMS sequences automatically re-engage by patient and recall type ('Mochi is due for his rabies booster — Tuesday at 10 AM works for Dr. Reyes'), with replies routed back to your front desk.",
        },
        {
          title: "Recover the dormant client base.",
          body: "Beyond recalls, your CRM has ex-active clients — pets adopted years ago who haven't been in for 18 months. Recovery campaigns reach back out with empathy-aware messaging ('It's been a while since we saw [patient name] — how is everyone?'). You'd be surprised how many bring a new puppy or moved-in cat back into the practice when reminded.",
        },
        {
          title: "Patient profiles that surface chart context on every call.",
          body: "When the phone rings and it's a known client, Neverr's caller profile flags the patient — last visit, chronic conditions, current medications, alerts. The AI doesn't make Mrs. Patterson re-introduce herself or re-explain that her dog has CKD.",
        },
        {
          title: "Multi-location support for hospital groups.",
          body: "For clinics with 2-8 locations, Neverr handles centralized intake with location-specific routing. Each clinic has its own DVM rotation, emergency protocols, recall sequences — but the platform is one. The relationship stays with your group.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for veterinary medicine. Priced predictably. Triages like a CVT.",
      blocks: [
        {
          title: "Trained on veterinary practice. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'vet' landing page. Neverr is trained on veterinary triage protocols — species-specific symptom patterns, sex- and species-specific emergency thresholds, toxin exposure timelines, current-medication-aware questions.",
        },
        {
          title: "Predictable pricing. No per-minute, no per-call.",
          body: "The veterinary answering service market punishes you exactly when emergency volume is highest. Neverr is flat-rate. Your bill in the December holiday rush — when chocolate, raisin, and antifreeze cases peak — looks like your bill in March.",
        },
        {
          title: "Grief-aware, end-of-life-respectful by design.",
          body: "Euthanasia scheduling, post-loss condolence calls, hospice consultations, aftercare arrangements require human warmth, not AI triage. Neverr is configured to recognize bereavement-pattern language and immediately route to your on-call human staff with no triage attempt and no scripted response.",
        },
        {
          title: "Plugs into your existing PIMS and phone system.",
          body: "You don't need to replace Cornerstone, AVImark, or ezyVet to add Neverr. We forward from your existing clinic line, integrate via Zapier or webhook, and go live in days.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the PIMS your clinic already uses.",
      body: STANDARD_INTEGRATION_BODY("veterinary practice management software"),
      examples: ["ezyVet", "Cornerstone", "AVImark", "eVetPractice", "Hippo Manager", "ImproMed"],
    },
    close: {
      headline: "Stop sending your clients to the 24-hour ER.",
      subhead:
        "When a vet practice routes after-hours calls to voicemail, the case — and the client — walks to whoever answers next. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Veterinary Clinics — AI Receptionist with Species-Specific Triage",
      description:
        "Vet-trained AI receptionist with species-and-symptom triage, emergency escalation, recall sequences, and PIMS integration via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "med-spas",
    name: "Med Spas",
    category: "health-wellness",
    emoji: "💉",
    featured: true,
    shortPitch: "Treatment-specific intake, deposit collection, HIPAA + BAA from day one.",
    hero: {
      headline: "Never lose another high-ticket lead at 7 PM.",
      subhead:
        "Neverr is the AI receptionist trained for med spas. It identifies treatment interest in seconds, gives honest pricing ranges, books consultations with the right provider, collects deposits during the call, and books directly into Boulevard, Mangomint, or Mindbody — HIPAA-compliant, BAA signed at startup.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a CoolSculpting inquiry",
    },
    pain: [
      {
        title: "It treats every consultation as one bucket.",
        body: "A Botox lead, a CoolSculpting lead, a weight-loss program lead, a rhinoplasty lead — different qualification, different consultation length, different provider, different deposit, different pricing range. Generic AI books 'consultation,' your front desk plays detective in the morning, and the lead has often booked elsewhere by then.",
      },
      {
        title: "It can't be HIPAA compliant.",
        body: "Many AI receptionists explicitly state they cannot serve medical aesthetics because they don't sign BAAs. Med spas that connected one anyway are exposed to real liability. The compliance check isn't a feature — it's a requirement, and most products fail it silently.",
      },
      {
        title: "It walks your highest-ticket calls to your competitor.",
        body: "A missed Botox inquiry is $600. A missed CoolSculpting consultation is $3,000. A missed rhinoplasty lead is $15,000. Average med spa misses 29% of calls during business hours and nearly 100% after hours. Compounded across a year, that's six to seven figures of revenue walking to whoever answers first.",
      },
    ],
    proof: {
      title: "Watch Neverr handle an after-hours CoolSculpting inquiry from RealSelf.",
      setup: "Thursday, 7:34 PM. Office closed at 6. New prospect researching CoolSculpting, comparing 3 providers.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Thanks for calling Glow Aesthetic — this is the after-hours line. I'm Neverr, working with Dr. Raman's practice. How can I help you tonight?",
        },
        {
          speaker: "Caller",
          text: "Hi, I was looking at your CoolSculpting reviews on RealSelf and I had some questions. Is anyone available to talk?",
        },
        {
          speaker: "Neverr",
          text: "Dr. Raman and our body contouring team are out for the evening, but I can answer most of your questions and get you set up for a complimentary consultation. May I ask — have you had CoolSculpting before, or any other body contouring treatments?",
        },
        {
          speaker: "Caller",
          text: "No, this would be my first time. I've been researching for a while. I'm thinking about my lower abdomen and flanks.",
        },
        {
          speaker: "Neverr",
          text: "Common starting point. Most patients addressing those areas see best results with two cycles per area, sometimes three depending on tissue thickness. Dr. Raman's team will assess that in person. To set expectations on pricing — CoolSculpting at our practice runs $750 per cycle, with package pricing for 4 cycles or more. For lower abdomen and flanks, you're typically looking at a 4-cycle plan at around $2,400 to $3,000. The consultation itself is complimentary.",
        },
        { speaker: "Caller", text: "That's actually similar to other quotes I've gotten. Is Dr. Raman board certified?" },
        {
          speaker: "Neverr",
          text: "Yes — Dr. Raman is a board-certified dermatologist and our medical director. She personally consults on all body contouring patients. The treatments themselves are performed by her certified body contouring specialists under her supervision.",
        },
        { speaker: "Caller", text: "Sounds good. Do you have anything next week?" },
        {
          speaker: "Neverr",
          text: "We have Tuesday at 2 PM with Dr. Raman, or Thursday at 10:30 AM with her associate Dr. Park. Both are equally qualified.",
        },
        { speaker: "Caller", text: "Tuesday at 2 works great." },
        {
          speaker: "Neverr",
          text: "Booking Tuesday at 2 PM, complimentary CoolSculpting consultation, 45 minutes. Two things to confirm: First, our practice requires a $100 deposit to hold the consultation slot, fully applied to your treatment if you proceed, or refunded if you cancel with 48 hours notice. Second, I'll need to send you a secure link to fill out our intake forms before the appointment. Would you like me to text the deposit link and intake forms to the number you're calling from?",
        },
        { speaker: "Caller", text: "Yes, that works." },
      ],
      durationLabel: "Duration: 3:18",
      handoffMarkers: [
        "NEW LEAD CREATED in Boulevard via Zapier — Lisa Martinez",
        "Source: RealSelf — CoolSculpting interest",
        "Treatment interest: CoolSculpting, lower abdomen + flanks",
        "Patient status: NEW (no prior treatments)",
        "Consultation booked: Tue 2:00 PM, Dr. Raman, 45 min, complimentary",
        "Deposit link: SMS sent ($100 secure payment link)",
        "Intake forms: SMS sent (HIPAA-compliant link)",
        "Pricing communicated: $750/cycle, $2,400-$3,000 typical 4-cycle plan",
      ],
      caption:
        "Three minutes, eighteen seconds. RealSelf-sourced lead, treatment-specific qualification, honest pricing range communicated, board-certified medical director scope clarified, consultation booked with the right provider, $100 deposit collected via secure SMS link, HIPAA-compliant intake forms sent, Boulevard synced.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. We sign your BAA at signup — before any patient data flows.",
      },
      {
        step: "02",
        title: "Tell us about your practice (~10 minutes)",
        body: "Pick 'Med Spa' — we pre-load the playbook. Add your medical director, your providers (RN injector, NP injector, MD, esthetician with scope-of-practice rules per state), treatment menu with pricing ranges, consultation lengths per treatment type, deposit policies, cancellation rules.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Treatment-specific qualification. Pricing-range communication. Consultation booked with the right provider. Deposit collected via secure SMS payment link.",
      },
    ],
    whatItHandles: [
      "Treatment-specific qualification — injectables, body, skin, medical weight loss, IV therapy, PRP, hair, hormones",
      "Honest pricing-range communication — anchored to your practice's actual fees",
      "Provider routing by scope of practice — RN/NP for tox/filler, MD for body, esthetician for skin",
      "Deposit collection during the call — secure SMS payment link, no card-over-phone",
      "Intake forms via SMS — HIPAA-compliant secure link",
      "Multi-touch reminder sequences — T-48h, T-24h, T-2h",
      "Membership and package qualification",
      "Returning client recognition",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for known clients, complex cases, anything outside scope",
      "Spam filtering — extended-warranty, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the consultation is the start. Retention, recovery, and lifetime value are where the platform compounds.",
      blocks: [
        {
          title: "Recovery campaigns for the leads who didn't book.",
          body: "Most med spas have hundreds of leads who consulted but didn't book treatment, or booked once and never returned. Neverr's recovery campaigns automatically re-engage with treatment-specific outreach — 'Lisa, it's been 90 days since your CoolSculpting consultation — Dr. Raman has a Tuesday opening if you're ready.'",
        },
        {
          title: "No-show reduction with deposit + reminder sequences.",
          body: "At $450-$600 average appointment value, every no-show costs real money. Automated SMS reminders reduce no-shows by 40-50%; deposit + clear cancellation policy cuts another 15%. Neverr handles the deposit collection during the booking call and surfaces unconfirmed appointments in your morning huddle.",
        },
        {
          title: "Caller profiles that recognize your retention base.",
          body: "The Botox client who's due for her quarterly retreat. The semaglutide patient on month 4 of her program. The CoolSculpting graduate considering a second area. Neverr surfaces full context on connect.",
        },
        {
          title: "Treatment-specific analytics: which sources actually convert?",
          body: "Most practices know what they spend on Instagram, Google Ads, RealSelf, and influencer partnerships. Few know which source converts to actual booked treatment. Neverr's analytics dashboard breaks down the funnel by lead source, treatment interest, consultation-to-treatment conversion.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for aesthetic medicine. HIPAA-compliant from day one. Predictable pricing.",
      blocks: [
        {
          title: "Trained on aesthetic medicine. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'med spa' landing page. Many can't even sign a BAA. Neverr is trained on aesthetic medicine workflows — injectable vs. body vs. skin vs. weight loss qualification, scope-of-practice routing, honest pricing-range communication, deposit collection during the call.",
        },
        {
          title: "HIPAA, BAA, and audit logging. Standard, not add-on.",
          body: "You sign our BAA at signup. All call data is encrypted in transit and at rest. Role-based access controls and full audit logging on every patient interaction. PII redaction configurable per business. SOC 2 in progress.",
        },
        {
          title: "Predictable pricing. No per-minute, no per-call, no high-ticket-call surcharges.",
          body: "The med spa AI receptionist market is full of pricing traps. Neverr is flat-rate. Your bill in November's holiday-Botox surge looks like your bill in February.",
        },
        {
          title: "Plugs into your existing PMS without ripping out your stack.",
          body: "You don't need to leave Boulevard, Mangomint, Mindbody, Aesthetic Record, Symplast, or Zenoti. We forward from your existing line, integrate via Zapier or webhook, and go live in days.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the tools you already use.",
      body: STANDARD_INTEGRATION_BODY("med spa PMS platforms"),
      examples: ["Boulevard", "Mangomint", "Mindbody", "Aesthetic Record", "Symplast", "Zenoti", "AestheticsPro"],
    },
    close: {
      headline: "Stop letting $600-$15,000 leads walk to your competitor.",
      subhead:
        "Med spas miss 29% of calls during business hours and nearly 100% after hours — at booking values of $600-$15,000 per call. Try Neverr free for 7 days. BAA signed before any patient data flows.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Med Spas — HIPAA-Compliant AI Receptionist with Deposit Collection",
      description:
        "Med spa-trained AI receptionist with treatment-specific qualification, honest pricing communication, and deposit collection during the call. HIPAA-compliant. Try free for 7 days.",
    },
  },

  // ==========================================================================
  // PROFESSIONAL SERVICES (2)
  // ==========================================================================
  {
    slug: "law-firms",
    name: "Law Firms",
    category: "professional-services",
    emoji: "⚖️",
    featured: true,
    shortPitch: "Practice-area-specific intake, conflict checks, sub-second response.",
    hero: {
      headline: "Never miss another high-value lead at 9pm.",
      subhead:
        "Neverr is the AI receptionist trained for legal intake. It identifies practice area in seconds, runs structured qualification, runs a basic conflict check, and books the consultation directly into Clio, MyCase, or PracticePanther — before your competitor's phone rings.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a PI intake",
    },
    pain: [
      {
        title: "It can't tell a $5K matter from a $500K case.",
        body: "'I was rear-ended' is a personal injury intake. 'My spouse filed for divorce' is family law. 'I got a DUI last night' is criminal defense. Each has different qualification questions, different urgency, different attorney routing. Generic AI captures 'I want a lawyer' and routes everything the same.",
      },
      {
        title: "It can't run a conflict check.",
        body: "Every legal intake needs to ask: 'Have you contacted any other attorneys? Are you currently represented?' Generic AI doesn't know to ask. The first time your attorney finds out about a conflict is when they're already 20 minutes into the consultation.",
      },
      {
        title: "It misses the data your CRM needs.",
        body: "Clio Grow, MyCase, and PracticePanther have specific intake fields — incident date, injury type, opposing party, jurisdiction, prior representation. Generic AI dumps a call summary as text. Your paralegal re-enters everything. Every. Single. Lead.",
      },
    ],
    proof: {
      title: "Watch Neverr handle an after-hours PI intake.",
      setup: "Friday, 9:47 PM. Caller in distress, just had a car accident that afternoon.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Thank you for calling Hartman Law Group, this is the after-hours line. I'm here to help — what happened?",
        },
        {
          speaker: "Caller",
          text: "I was in a car accident this afternoon. Some guy ran a red light and hit my car on the driver's side. I'm at the hospital now and they're saying I have a fractured collarbone and a concussion.",
        },
        {
          speaker: "Neverr",
          text: "I'm so sorry that happened to you. Your safety comes first — I'm glad you're getting medical care. I want to make sure we can help you. Is that okay?",
        },
        { speaker: "Caller", text: "Yes please." },
        { speaker: "Neverr", text: "First — were the police called to the scene, and was a report filed?" },
        { speaker: "Caller", text: "Yes, the police came. I have the report number on a card they gave me." },
        { speaker: "Neverr", text: "Good. Hold onto that. Where did the accident happen — what city and state?" },
        { speaker: "Caller", text: "San Francisco, California." },
        { speaker: "Neverr", text: "And the at-fault driver — were they cited or arrested?" },
        { speaker: "Caller", text: "The officer said they cited him for running the red light. I think he might have been on his phone too." },
        {
          speaker: "Neverr",
          text: "That's a strong indicator of liability. Now, this is important — have you spoken to anyone from the at-fault driver's insurance company yet, or signed anything?",
        },
        { speaker: "Caller", text: "No, no one's called me yet." },
        {
          speaker: "Neverr",
          text: "Good — please don't speak with their insurance until you've talked to one of our attorneys. They may try to settle quickly for less than your case is worth. One more — are you currently or have you previously been represented by another attorney for this accident?",
        },
        { speaker: "Caller", text: "No, you're the first I called." },
        {
          speaker: "Neverr",
          text: "Perfect. Based on what you've told me — driver-side impact, red-light violation by the at-fault driver, fractured collarbone, concussion, police report on file — this sounds like a case our PI team would want to take. Mr. Hartman personally calls every PI lead within 30 minutes after hours.",
        },
      ],
      durationLabel: "Duration: 3:24",
      handoffMarkers: [
        "NEW LEAD CREATED in CRM via Zapier — Maria Lopez",
        "Practice area: Personal Injury (auto accident)",
        "Intake fields populated: incident date, location, injury type, liability indicators, medical treatment status, insurance contact status, prior representation status, statute of limitations flag",
        "Conflict check: clear (no prior representation)",
        "Lead score: HIGH (clear liability, documented injuries, no prior counsel, within SOL)",
        "Attorney notification sent to Mr. Hartman (after-hours protocol)",
        "Caller advised: photo documentation, no social media, no insurer contact",
      ],
      caption:
        "Three minutes, twenty-four seconds. Auto accident lead, practice area identified, structured intake completed, conflict check run, statute-of-limitations flagged, attorney-handoff coaching delivered, lead created in your CRM with all fields populated.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. We sign your engagement-protection terms at signup.",
      },
      {
        step: "02",
        title: "Tell us about your firm (~10 minutes)",
        body: "Pick 'Law Firm' — we pre-load the playbook. Add your practice areas (PI, family, criminal defense, immigration, estate, business, employment, IP). Define your intake protocols per area, conflict-check rules, after-hours escalation paths, jurisdictions.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Practice-area identification in the first 10 seconds. Structured intake. Conflict check. Lead created in your CRM with full fields populated.",
      },
    ],
    whatItHandles: [
      "Practice-area triage — PI, family, criminal defense, immigration, estate, business, employment, IP, real estate",
      "Structured intake — captures the fields your CRM needs, not just a call summary",
      "Conflict check protocol — asks the right questions, flags potential conflicts",
      "Statute-of-limitations awareness — captures incident dates, flags time-sensitive matters",
      "After-hours emergency triage — criminal defense calls, custody emergencies, restraining order needs",
      "Lead scoring — qualifies leads as high / medium / referral-out based on your criteria",
      "Bilingual intake — English and Spanish from day one",
      "Attorney escalation — routes urgent matters to on-call attorneys; routine to next-business-day",
      "Spam and lead-gen filtering — extended-warranty, scams, competitor intake-baiting killed silently",
      "Live transfer — for anything outside scope, transfers with full context to your team",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Capturing the lead is one step. Converting it to a signed client is the platform's job too.",
      blocks: [
        {
          title: "Recovery campaigns for unsigned matters.",
          body: "Most firms have hundreds of leads who consulted but never signed — fee questions, 'I need to talk to my spouse,' 'I'm still thinking.' 80% of conversions occur between the 5th and 12th contact — and that's the gap recovery campaigns close. Neverr's automated SMS sequences re-engage dormant leads on the right cadence, with templates per practice area, until they sign or explicitly opt out.",
        },
        {
          title: "Objection Intelligence configured for legal hesitation.",
          body: "'Let me think about it.' 'How much will this cost?' 'Can I talk to the lawyer first?' These are the conversion-killers in legal intake. Neverr's Objection Intelligence is configurable per practice — you train it on your best responses, and the AI deploys them in real time during the call.",
        },
        {
          title: "Competitive Intelligence when callers shop around.",
          body: "Personal injury especially: callers are calling 3-5 firms in succession. When they mention a competitor's name — 'I also called [other firm]' — Neverr responds with your configurable counter ('Mr. Hartman handles every case personally; large-firm intake hands you to a paralegal until trial'). The competitor mentioned, the response delivered, the comparative advantage made before the caller has even hung up.",
        },
        {
          title: "Analytics: source → consultation → retainer funnel.",
          body: "Most firms know their cost per lead. Few know their cost per signed client by source. Neverr's analytics dashboard breaks down the funnel — Google Ads vs. Local Service Ads vs. referrals vs. SEO — showing where consultations come from, which sources convert to retainers, and which are burning your ad spend.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for legal intake. Priced predictably. Privilege-aware.",
      blocks: [
        {
          title: "Trained on legal intake. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'law firm' landing page. They take a message and pass it along. Neverr is trained on legal intake protocols by practice area — PI, family, criminal defense, immigration, estate, business — with structured qualification, conflict checks, and statute-of-limitations awareness.",
        },
        {
          title: "Predictable pricing. No per-minute, no per-call, no human-handoff surcharges.",
          body: "The legal answering service market is full of pricing traps. Neverr is flat-rate. Every plan includes the AI, the legal-trained intake, the CRM integration, the after-hours coverage, and the analytics. Your bill in October — when you're running a TV campaign — looks like your bill in February.",
        },
        {
          title: "Privilege-aware. Encryption, audit logs, escalation protocols, no AI-given legal advice.",
          body: "Neverr never gives legal advice. It qualifies leads and books consultations — the way a trained intake specialist would. All call data is encrypted in transit and at rest. Full audit logging on every interaction. We don't establish privilege; your attorney does, on the privileged consultation that follows.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the practice management software you already use.",
      body: STANDARD_INTEGRATION_BODY("legal practice management and intake CRMs"),
      examples: ["Clio Manage", "Clio Grow", "MyCase", "PracticePanther", "Lawmatics", "CASEpeer", "Filevine"],
    },
    close: {
      headline: "Stop burning your ad spend on missed calls.",
      subhead:
        "Law firms lose an average of $300K+/year to missed intake calls. The first attorney to a live conversation signs the case 70% of the time. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Law Firms — AI Receptionist for Legal Intake",
      description:
        "Legal-trained AI receptionist with practice-area-specific intake, conflict checks, and bidirectional Clio / MyCase / PracticePanther integration via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "real-estate-agents",
    name: "Real Estate Agents",
    category: "professional-services",
    emoji: "🏠",
    featured: true,
    shortPitch: "Sub-second response, buyer/seller branching, multi-month nurture.",
    hero: {
      headline: "Be the first agent who responds. Every time.",
      subhead:
        "Neverr is the AI receptionist trained for real estate. It answers in under a second, branches buyer vs. seller intake instantly, runs procuring-cause-safe qualification, books showings into your calendar, and nurtures leads for months — while you're in showings, with clients, or with your family.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a buyer inquiry",
    },
    pain: [
      {
        title: "It runs the same script for buyers and sellers.",
        body: "A buyer inquiry needs pre-approval, price range, timeline, school district, procuring cause check. A seller inquiry needs address, ownership timeline, motivation, occupancy status. Generic AI asks both groups the same questions, captures none of them well, and hands your CRM a useless lead summary.",
      },
      {
        title: "It can't be first when first matters most.",
        body: "78% of buyers and 78% of sellers go with the first agent who responds substantively. Agents who respond within 5 minutes are 21x more likely to qualify the lead than those who wait 30 minutes. Generic AI takes 8-15 seconds to engage. Sub-second is the discriminator.",
      },
      {
        title: "It captures the lead and stops.",
        body: "80% of sales require 5 or more follow-up contacts; the average agent never responds to 60% of leads at all. The gap between 'captured' and 'signed' is months of nurture, and most AI receptionists tap out the moment the call ends.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a buyer inquiry from Zillow.",
      setup: "Saturday, 3:14 PM. Caller is a buyer who saw a listing on Zillow. Agent (Sarah Park) is in another showing.",
      transcript: [
        { speaker: "Neverr", text: "Sarah Park's office, this is Neverr — I work with Sarah. How can I help?" },
        { speaker: "Caller", text: "Yeah hi, I'm calling about the house on Oak Street. The 3-bedroom one. Is it still available?" },
        {
          speaker: "Neverr",
          text: "412 Oak Street — yes, still available, listed at $749,000. Sarah's actually showing another property right now but I can help you get a showing scheduled and let her know you called. Quick question — are you currently working with another real estate agent?",
        },
        { speaker: "Caller", text: "No, just looking on my own." },
        { speaker: "Neverr", text: "Got it. And are you pre-approved for a mortgage, or paying cash?" },
        { speaker: "Caller", text: "Pre-approved, conventional loan. Up to about 800." },
        {
          speaker: "Neverr",
          text: "Perfect, that puts Oak Street well within your range. What's your timeline — looking to move in the next 30 days, 60-90 days, or further out?",
        },
        { speaker: "Caller", text: "Honestly soon. Our lease is up in 6 weeks." },
        { speaker: "Neverr", text: "Sounds like a serious search. Are you currently renting, and is this for you and family?" },
        {
          speaker: "Caller",
          text: "Yeah, renting an apartment downtown. Me, my wife, and we have a one-year-old. We're looking at the Oak Street area specifically because of the elementary school district.",
        },
        {
          speaker: "Neverr",
          text: "Good neighborhood for that — Lincoln Elementary is one of the top-rated. Sarah specializes in that pocket; she'll be a great match. Let me get you scheduled to see Oak Street. What works better — later this afternoon around 5:30, or tomorrow morning at 10?",
        },
        { speaker: "Caller", text: "Tomorrow 10 would be great." },
      ],
      durationLabel: "Duration: 3:11",
      handoffMarkers: [
        "NEW LEAD CREATED in CRM via Zapier — David Reyes",
        "Source: Zillow Premier Agent — 412 Oak Street",
        "Lead type: BUYER, qualified",
        "Pre-approval: yes, conventional, $800K cap",
        "Timeline: 30-45 days (lease ending 6 weeks)",
        "Family: couple + 1-year-old, school district priority",
        "Procuring cause check: not currently working with another agent ✓",
        "Showing booked: Sunday 10:00 AM, 412 Oak Street, Sarah Park",
        "Sarah's intro text: queued for tonight 7:00 PM",
      ],
      caption:
        "Three minutes, eleven seconds. Zillow lead, source attributed, buyer branch identified, pre-approval and timeline qualified, procuring-cause check passed, showing booked, off-market nurture list opt-in captured, CRM synced — all while Sarah finished her other showing.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number. Card optional during the 7-day trial." },
      {
        step: "02",
        title: "Tell us about your practice (~5 minutes)",
        body: "Pick 'Real Estate' — we pre-load the playbook. Add your service area, price-band specializations, buyer-rep agreement language, seller-side disclosure protocols, team structure. Connect Google Calendar or Outlook. Map your CRM via Zapier or webhook.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Buyer-vs-seller branching qualification in the first 10 seconds. Showings booked into your calendar. Multi-month SMS nurture for any lead not ready today.",
      },
    ],
    whatItHandles: [
      "Buyer-branch qualification — pre-approval, price range, areas, timeline, family/lifestyle, procuring cause check",
      "Seller-branch qualification — address, ownership timeline, motivation, mortgage situation, occupancy",
      "Showing booking — calendar-aware, with owner-confirmation flow for occupied properties",
      "Buyer rep / dual agency-safe language — never makes representation claims",
      "CMA appointment scheduling — for sellers who want a price opinion",
      "Source attribution — Zillow, Realtor.com, Homes.com, Google LSA, Facebook Ads, web form, organic — captured per lead",
      "Off-market / pre-market list opt-in",
      "After-hours coverage — handles the 7 PM-11 PM seller decision window",
      "Multilingual handling — English and Spanish from day one",
      "Live transfer — to the agent for hot leads, signed clients, or anything outside scope",
      "Spam filtering — wholesaler bait calls, lead-gen scrapers, scams killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Capturing the lead is one minute. Nurturing them to closing is one season. The platform does both.",
      blocks: [
        {
          title: "Multi-month SMS nurture sequences for the 90% of leads who aren't ready today.",
          body: "Most leads aren't transacting next week. They're 30, 60, 90 days out. Generic AI captures them and dumps them in your CRM, where they go quiet for 60 days and die. Neverr's SMS sequences run automated nurture flows tailored to lead type — 'Just sold a home like yours on Maple Street' for sellers, 'New listing in your search area' for buyers — paced over weeks and months.",
        },
        {
          title: "Recover the dead leads in your CRM.",
          body: "Every agent has hundreds of leads in their CRM marked 'interested' 90+ days ago that nobody's touched since. Neverr's recovery campaigns automatically re-engage dormant contacts with personalized outreach — 'Has anything changed in your search?' — segmented by their original interest profile.",
        },
        {
          title: "Caller profiles that recognize past inquiries.",
          body: "The buyer who called 8 months ago and said 'we're 6 months out' — they're due now. When their number lights up, Neverr's caller profile flags them, surfaces what they originally told you, and the AI greets them with full context. 'Welcome back, David — last time we spoke you were looking in the Lincoln district, $750K range.'",
        },
        {
          title: "Source-attributed analytics: which leads actually convert?",
          body: "Most agents know roughly what they spend on Zillow, Realtor.com, and Google. Few know which source actually closes. Neverr's analytics dashboard breaks down the funnel by source — which leads got past first call, which booked showings, which converted to clients.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for real estate. Priced predictably. First, every time.",
      blocks: [
        {
          title: "Trained on real estate. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'real estate' landing page. They run one intake script for everyone. Neverr is trained on real estate workflows — buyer-vs-seller branching, procuring-cause-safe language, dual-agency state law sensitivity, occupied-vs-vacant showing protocols, source attribution.",
        },
        {
          title: "Sub-second response. Not 'fast for AI' — actually fast.",
          body: "The '5-minute response' rule is the wrong rule for real estate. Sellers who don't get an immediate response call the next agent on their list within 4 minutes. The right number is sub-1-second — answered before the caller has finished their first thought. Neverr is built for this.",
        },
        {
          title: "Predictable pricing. No per-lead, no per-conversation.",
          body: "The real estate AI market is full of pricing traps. Neverr is flat-rate. Your bill in March's spring market looks like your bill in December's slow month.",
        },
        {
          title: "Procuring-cause-safe by design.",
          body: "Neverr never makes representation claims, never says 'I am Sarah,' never advises on legal or fiduciary matters. It qualifies and books — clearly identifying as Neverr-working-with-Agent — and routes anything that touches representation, dual agency, or fiduciary duty to the licensed agent.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the tools you already use.",
      body: STANDARD_INTEGRATION_BODY("real estate CRMs and lead-source platforms"),
      examples: ["Follow Up Boss", "kvCORE", "Sierra Interactive", "Chime", "LionDesk", "Top Producer", "BoomTown"],
    },
    close: {
      headline: "Stop being the second agent.",
      subhead:
        "78% of homebuyers and 78% of sellers go with the first agent who responds substantively. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Real Estate Agents — AI Receptionist with Sub-Second Response",
      description:
        "Real estate-trained AI receptionist with buyer-vs-seller branching, procuring-cause-safe qualification, showing booking, and multi-month SMS nurture. Try free for 7 days.",
    },
  },

  // ==========================================================================
  // HOSPITALITY & LIFESTYLE (6)
  // ==========================================================================
  {
    slug: "hotels",
    name: "Hotels & Motels",
    category: "hospitality-lifestyle",
    emoji: "🏨",
    featured: true,
    shortPitch: "Reservations, group bookings, OTA price-shopping counter, multi-language.",
    hero: {
      headline: "Never miss another booking call during the check-in rush.",
      subhead:
        "Neverr is the AI receptionist trained for hotels and motels. It handles reservations, group inquiries, OTA price-shopping calls, and guest service requests — sub-second answer, native multi-language, no front desk interruption.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a Saturday night reservation",
    },
    pain: [
      {
        title: "It can't tell a reservation call from a service request.",
        body: "A new booking inquiry is revenue. A guest needing extra towels is operations. A group booking inquiry is high-value sales. Generic AI treats them all the same and your front desk plays sorter.",
      },
      {
        title: "It can't price-shop intelligently.",
        body: "OTAs (Expedia, Booking.com) often quote a different price than your direct rate. Educated guests call to ask. Generic AI doesn't know your direct-booking incentives, doesn't push the loyalty program, doesn't hold the rate parity story.",
      },
      {
        title: "It interrupts your check-in experience.",
        body: "The 3-6 PM check-in rush is your front desk's most important hour. Every phone interruption is a guest experience hit. Generic AI just records messages your team has to return after.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a Saturday night reservation from a Booking.com price-shopper.",
      setup: "Saturday, 8:14 PM. Guest is on Booking.com but called to verify the rate before booking.",
      transcript: [
        { speaker: "Neverr", text: "Bayside Inn Riverside, this is the front desk line. How can I help?" },
        {
          speaker: "Caller",
          text: "Hi, I'm looking at your hotel on Booking.com — checking in tomorrow night, two nights, king room. Do you have anything available?",
        },
        {
          speaker: "Neverr",
          text: "Yes, we have king rooms available for tomorrow and Sunday — both nights. Booking.com is showing $189 per night, but if you book direct with us, our rate is $169 per night, and we throw in complimentary parking and breakfast for two. Would you like me to set that up?",
        },
        { speaker: "Caller", text: "Wait, that's actually cheaper than the OTA. And free breakfast?" },
        {
          speaker: "Neverr",
          text: "Direct guests get our best rate plus extras. If you sign up for our free loyalty program at the same time, you'll also get a $20 dining credit usable at our restaurant. Takes about 30 seconds — just your email and phone number.",
        },
        { speaker: "Caller", text: "Yes, let's do all of it." },
        {
          speaker: "Neverr",
          text: "Great. Two nights at $169, complimentary parking, complimentary breakfast for two, $20 dining credit, loyalty enrollment. To secure the booking I'll need a credit card on file — just hold authorization, no charge until check-in. I'll text you a secure link to enter the card.",
        },
        { speaker: "Caller", text: "Perfect, what's your address?" },
      ],
      durationLabel: "Duration: 2:47",
      handoffMarkers: [
        "RESERVATION CREATED in PMS via Zapier — King room, 2 nights",
        "Direct rate applied: $169/night vs. $189 OTA",
        "Loyalty member created: enrolled at booking",
        "Inclusions: parking, breakfast for 2, $20 dining credit",
        "CC capture: secure SMS link sent (Stripe-backed pre-auth)",
        "Confirmation: email + SMS on card capture",
        "Direct-booking conversion saved 15% commission",
      ],
      caption:
        "Two minutes, forty-seven seconds. OTA price-shopper converted to direct booking with loyalty enrollment, secure card capture via SMS link, PMS synced — saving 15% OTA commission while improving guest experience.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your property (~10 minutes)",
        body: "Pick 'Hotel' — we pre-load the playbook. Add room types, rates, amenities, loyalty program rules, group booking thresholds, multi-language preferences. Connect your PMS via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Reservations + service requests + group inquiries triaged correctly. PMS synced.",
      },
    ],
    whatItHandles: [
      "Reservation inquiries with rate quotes, availability, room type matching",
      "Group bookings (5+ rooms) — flagged for sales team callback with structured intake",
      "OTA price-shopping calls — counter with direct-booking incentives + loyalty enrollment",
      "Cancellation/modification requests",
      "Wake-up calls, late checkout, room service requests",
      "Local recommendations (configurable by property)",
      "Lost-and-found intake",
      "Bilingual (English/Spanish) from day one + French/German/Italian/Portuguese available",
      "After-hours emergency routing (medical, security) to human staff",
      "Live transfer to front desk for known issues or VIP guests",
      "Spam filtering — extended-warranty, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the room is the start. The platform fills empty nights, recovers OTA leakage, and turns one-night guests into loyalty members.",
      blocks: [
        {
          title: "Recovery campaigns for past guests.",
          body: "Most hotels have thousands of past guests who haven't returned in 12+ months. Generic AI takes the booking and stops. Neverr's recovery campaigns automatically re-engage past guests at the right cadence ('It's been a year since your last stay — Memorial Day weekend has special direct rates'), segmented by stay type, party size, and last-stay length.",
        },
        {
          title: "Group + corporate inquiry capture, not lost.",
          body: "Group inquiries (weddings, conferences, sports teams, corporate retreats) are high-value but slow-cycle. They don't book on the call — they need a sales follow-up. Neverr captures the structured intake (dates, room block size, F&B needs, AV requirements, point of contact) and creates a structured lead in your sales CRM.",
        },
        {
          title: "Guest profiles that surface preferences before they arrive.",
          body: "Returning guest calls? Neverr's caller profile recognizes them, surfaces last-stay preferences (king vs. two queens, high floor, late checkout), loyalty status, and any flagged notes. The check-in experience starts on the booking call.",
        },
        {
          title: "Multi-property routing for hotel groups.",
          body: "For independent groups with 2-15 properties, Neverr handles centralized intake with property-specific routing. Each property gets its own rates, amenities, policies, and PMS integration — but the platform is one.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for hospitality. Priced predictably. Multi-language native.",
      blocks: [
        {
          title: "Trained on hospitality. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'hotel' landing page. Neverr is trained on hospitality workflows — reservation vs. service vs. group triage, OTA-vs-direct pricing logic, loyalty enrollment, multi-language guest handling.",
        },
        {
          title: "Flat-rate pricing.",
          body: "No per-call surcharges during your busy season. Your bill at peak season looks like your bill in shoulder season.",
        },
        {
          title: "PMS-friendly via Zapier.",
          body: "You don't need to rip out Mews, Cloudbeds, or Opera. We integrate via Zapier or webhook with most hotel PMS systems.",
        },
        {
          title: "Native multi-language. Not English-with-translation-bolt-on.",
          body: "Spanish, French, German, Italian, Portuguese available. Cultural language detection identifies preferred language on the first call.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the PMS your property already uses.",
      body: STANDARD_INTEGRATION_BODY("hotel PMS systems"),
      examples: ["Mews", "Cloudbeds", "Opera", "Stayntouch", "Little Hotelier", "RoomRaccoon"],
    },
    close: {
      headline: "Stop letting your check-in rush cost you reservations.",
      subhead: "7-day free trial, sub-second answer, group inquiry capture, multi-language from call one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Hotels & Motels — AI Receptionist with Group Booking + Multi-Language",
      description:
        "Hotel-trained AI receptionist with sub-second answer, OTA price-shopping counter, group booking intake, and multi-language support. Integrates with major PMS via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "restaurants",
    name: "Restaurants",
    category: "hospitality-lifestyle",
    emoji: "🍽️",
    featured: true,
    shortPitch: "Reservations, takeout, private events — without adding payroll.",
    hero: {
      headline: "You can't hire your way out of the labor shortage. Solve it differently.",
      subhead:
        "Neverr is the AI receptionist trained for restaurants. It takes reservations, handles takeout orders, captures private event inquiries, answers menu questions — 24/7, in any language, without adding payroll.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a Friday night dinner rush",
    },
    pain: [
      {
        title: "You can't staff the phone anymore.",
        body: "985,000 unfilled jobs in restaurants and accommodations. Even when you fully staff the floor, the phone rings in the middle of the dinner rush and there's no one to pick it up. Generic AI rolls calls to voicemail; voicemail loses 65%+ of callers immediately.",
      },
      {
        title: "Every missed call is real money.",
        body: "150 calls/month missed × 60% would-have-converted × $45 average = $48,600/year walking to a competitor. Multiply that by takeout, private events, and reservations during peak hours.",
      },
      {
        title: "Hiring more isn't the answer.",
        body: "Replacing one hourly employee costs ~$2,000. Even if you hire, turnover destroys the math. The structural answer isn't more humans — it's the work that doesn't require humans being handled differently.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a Friday dinner rush.",
      setup: "Friday, 7:23 PM. Caller wants a Saturday 6-top reservation. Followed immediately by a private event inquiry.",
      transcript: [
        { speaker: "Neverr", text: "Trattoria Marco, this is the reservations line. How can I help?" },
        { speaker: "Caller", text: "Hi, I'd like to book a table for 6 tomorrow night, around 7:30 if possible." },
        {
          speaker: "Neverr",
          text: "Let me check — tomorrow at 7:30 for 6, we have one table available. Is this for a special occasion, and any dietary restrictions in your party?",
        },
        { speaker: "Caller", text: "It's my mom's birthday. One person is gluten-free, one is vegetarian." },
        {
          speaker: "Neverr",
          text: "Wonderful — happy birthday to your mom. I'll note both restrictions and we can prepare a complimentary tiramisu with a candle. Our gluten-free pasta options are clearly marked on the menu, and our chef can adapt several mains for vegetarian. Booking 6 tomorrow at 7:30. Can I get your name and best phone number?",
        },
        { speaker: "Caller", text: "Sarah Kim, 415-555-0419." },
        {
          speaker: "Neverr",
          text: "Got it, Sarah. You'll get a confirmation text in 2 minutes with directions and parking info. We do require 4-hour cancellation notice for parties of 5 or more. See you tomorrow at 7:30.",
        },
      ],
      durationLabel: "Duration: 1:54",
      handoffMarkers: [
        "RESERVATION BOOKED in Resy/OpenTable/Toast via Zapier — Sarah Kim, party of 6",
        "Saturday 7:30 PM — special occasion: birthday for mom",
        "Dietary restrictions: 1 gluten-free, 1 vegetarian — flagged for kitchen",
        "Special prep: complimentary tiramisu with candle",
        "Confirmation text scheduled: directions + parking + cancellation policy",
      ],
      caption:
        "Under two minutes. One Saturday-night booking secured, dietary restrictions captured for the kitchen, special occasion noted, confirmation flow triggered — without your host stepping away from the door at the busiest seating of the week.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number." },
      {
        step: "02",
        title: "Tell us about your restaurant (~5 minutes)",
        body: "Pick 'Restaurant' — we pre-load the playbook. Add menu, hours, reservation rules, takeout protocol, private event handling, dietary restriction capture, language preferences. Connect Resy/OpenTable/Toast via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Reservation/takeout/event sync via Zapier.",
      },
    ],
    whatItHandles: [
      "Reservations (single-party, group, special occasion)",
      "Takeout orders (including modifications, substitutions, dietary restrictions)",
      "Menu questions, pricing, ingredient/allergen lookups",
      "Private event inquiries with structured intake → routes to events manager",
      "Hours, location, parking, dress code, age policy",
      "Cancellations and modifications",
      "Lost-and-found, wait times, special-occasion accommodations",
      "Bilingual handling (English/Spanish) from day one + 7 more languages available",
      "Live transfer to manager for complaints, complex issues",
      "Spam filtering — robocalls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Taking the reservation is the start. The platform fills empty seats, brings guests back, and captures the events business most restaurants leak.",
      blocks: [
        {
          title: "No-show reduction with confirmation sequences.",
          body: "Reservations no-show at 15-30% nationally. Each empty 6-top on a Friday night is real money. Neverr sends confirmation texts at T-48h and T-24h, surfaces unconfirmed reservations in your morning prep dashboard so the host can call them proactively, and (with deposit policies) collects deposits during the booking call via secure SMS link.",
        },
        {
          title: "Recovery campaigns for past guests.",
          body: "Most restaurants have thousands of past guests who came once and never returned. Neverr's recovery campaigns automatically re-engage with personalized outreach segmented by visit type ('Welcome back — Tuesday is half-price wine night'), party size, and last-visit recency.",
        },
        {
          title: "Private event lead capture is no longer leaking.",
          body: "Private events — corporate dinners, rehearsal dinners, anniversaries, holiday parties — are high-margin but slow-cycle. Generic AI captures 'wants private event' and stops. Neverr captures structured event intake (date, headcount, F&B preferences, AV needs, budget signal, decision-maker contact) and creates a lead in your events CRM with full context.",
        },
        {
          title: "Multi-location support for restaurant groups.",
          body: "For groups with 2-15 locations, Neverr handles centralized intake with location-specific routing. Each location has its own menu, hours, reservation system, and dietary protocols — but the platform is one.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for restaurants. Labor-shortage-aware. Predictable pricing.",
      blocks: [
        {
          title: "Labor-shortage-aware (you don't have to compete for the host you can't find).",
          body: "Restaurants are 233,000 jobs below pre-pandemic levels in table service. Hiring isn't the answer — it's the bottleneck. Neverr handles the work that doesn't require a human, so the humans you do have can focus on the floor.",
        },
        {
          title: "Flat-rate pricing.",
          body: "No per-call surcharges during your dinner rush. Your bill on a busy Friday looks like your bill on a quiet Tuesday.",
        },
        {
          title: "Reservations + takeout + events in one. Not three different tools.",
          body: "Most restaurants juggle separate systems for each. Neverr handles all three on the same call, routes to the right system in your stack, and surfaces them in one dashboard.",
        },
        {
          title: "Bilingual native. Not English-only-with-press-2-for-Spanish.",
          body: "Spanish from day one. More languages available. Cultural language detection identifies preferred language on the first call.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the tools you already use.",
      body: STANDARD_INTEGRATION_BODY("restaurant reservation and POS systems"),
      examples: ["OpenTable", "Resy", "Toast", "Tock", "Yelp Reservations", "SevenRooms"],
    },
    close: {
      headline: "Stop competing for hosts you can't hire.",
      subhead: "7-day free trial, no card required, see what AI receptionist actually means for restaurant operations.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Restaurants — AI Reservations + Takeout Without Adding Payroll",
      description:
        "Restaurant-trained AI receptionist for reservations, takeout orders, private event capture. Built for the labor shortage. Integrates with OpenTable, Resy, Toast via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "gyms",
    name: "Gyms & Fitness Studios",
    category: "hospitality-lifestyle",
    emoji: "💪",
    featured: true,
    shortPitch: "Tour booking, class booking, member retention, dropout recovery.",
    hero: {
      headline: "Never miss another tour booking call.",
      subhead:
        "Neverr is the AI receptionist trained for gyms and fitness studios. It books tours, answers class questions, handles billing inquiries, books personal training intros — sub-second answer, integrates with Mindbody/Glofox/Momence via Zapier, doesn't interrupt your floor coaching.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it books a tour during peak class hours",
    },
    pain: [
      {
        title: "Your front desk physically can't get to the phone.",
        body: "Check-ins, walk-in tours, member questions, equipment concerns — your floor staff is doing 5 things at once. The phone rings, the prospect motivated to join right now hangs up, calls the next gym on Google, books with whoever picks up. Your front desk was 10 feet away.",
      },
      {
        title: "It treats every caller as a stranger.",
        body: "Members calling about billing, class waitlists, schedule changes need different handling than prospects asking about membership. Generic AI runs the same script for both. Members feel like they don't matter; prospects don't get qualified.",
      },
      {
        title: "It can't sell.",
        body: "A motivated prospect needs more than a message-taker. They need someone to qualify their goals (weight loss vs. strength vs. classes vs. PT), match them to the right membership tier, book a tour with the right time slot, and follow up. Generic AI takes a name and stops.",
      },
    ],
    proof: {
      title: "Watch Neverr book a tour during peak class hours.",
      setup: "Tuesday, 6:47 PM. Three classes running, prospect calls about membership.",
      transcript: [
        { speaker: "Neverr", text: "Apex Fitness, this is the membership line. How can I help?" },
        { speaker: "Caller", text: "Hi, I'm thinking about joining a gym. Can you tell me about your memberships?" },
        {
          speaker: "Neverr",
          text: "Happy to. Quick questions to point you to the right plan: are you looking mostly for the gym floor and equipment, group classes like spin or HIIT, or personal training?",
        },
        { speaker: "Caller", text: "Mostly classes. I want to do spin and yoga, maybe one PT session a month." },
        {
          speaker: "Neverr",
          text: "Got it. Our Class Plus plan is $89/month — unlimited group classes (spin, yoga, HIIT, strength, all included), gym floor access, and one complimentary PT session per month. Most members starting like you go with that. Are you flexible on contract — month-to-month, or are you good with a 12-month commit for a discount?",
        },
        { speaker: "Caller", text: "I'd want month-to-month to start." },
        {
          speaker: "Neverr",
          text: "Smart. Class Plus month-to-month, no enrollment fee right now if you sign up this week. Would you like to come in for a tour and a complimentary class? I have Saturday morning at 10 with our membership lead, Marcus, or Sunday afternoon at 2 PM.",
        },
        { speaker: "Caller", text: "Saturday at 10 works." },
      ],
      durationLabel: "Duration: 2:18",
      handoffMarkers: [
        "TOUR BOOKED in Mindbody via Zapier — Saturday 10 AM with Marcus (membership lead)",
        "Lead profile: classes-focused, considering Class Plus, month-to-month preference",
        "Notes: interested in spin + yoga, monthly PT add-on",
        "Promo code applied: no enrollment fee (this-week sign-up)",
        "Membership info text scheduled — 2 minutes",
        "Marcus notified of tour with full lead context",
      ],
      caption:
        "Two minutes, eighteen seconds. Goal-qualified prospect, recommended the right tier, tour booked with the membership lead, no-enrollment-fee promo applied — while three classes were running.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number." },
      {
        step: "02",
        title: "Tell us about your gym (~5 minutes)",
        body: "Pick 'Gym' — we pre-load the playbook. Add membership tiers, class schedule, trainer specializations, tour booking calendar, billing policies. Connect Mindbody/Glofox/Momence via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Tours booked with the right membership lead.",
      },
    ],
    whatItHandles: [
      "Tour booking for prospects with goal qualification (weight loss/strength/classes/PT/sport-specific)",
      "Class booking, waitlist management, cancellation handling",
      "Personal training intro booking with trainer matching",
      "Billing inquiries (payment dates, freeze policies, cancellation)",
      "Membership upgrade/downgrade requests",
      "Class schedule and instructor questions",
      "Equipment availability and gym amenity questions",
      "Member recognition via phone-number lookup",
      "Multi-location support for gym groups",
      "Bilingual (English/Spanish) from day one",
      "Live transfer for cancellations, complex billing, complaints (per your retention protocol)",
      "Spam filtering — extended-warranty calls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the tour is the start. The platform fills classes, retains members, and brings dropouts back.",
      blocks: [
        {
          title: "Recovery campaigns for lapsed members.",
          body: "Most gyms have hundreds of past members who canceled in the last 18 months. Neverr's recovery campaigns automatically re-engage with personalized outreach ('It's been 6 months — we have new HIIT classes that match what you used to do'), segmented by what they used to attend, when they canceled, and why.",
        },
        {
          title: "Class fill optimization with waitlist + reactivation flows.",
          body: "Empty class spots are pure waste. Neverr automatically pulls waitlisted members when cancellations happen, texts members who haven't attended their usual class in 2+ weeks, and surfaces underbooked classes in your dashboard so you can promote them.",
        },
        {
          title: "Member profiles that drive personalized retention.",
          body: "At-risk member profile flags (attendance dropping, complaint pattern, billing friction) surface in Neverr's dashboard. The AI recognizes high-risk members on every call, applies your retention protocol, and routes the right members to your retention specialist before they call to cancel.",
        },
        {
          title: "Multi-location support for gym groups.",
          body: "For chains with 2-50 locations, Neverr handles centralized intake with location-specific routing. Each location has its own classes, trainers, equipment, and pricing — but the platform is one.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for fitness. Priced predictably. Plugs into Mindbody/Glofox/Momence.",
      blocks: [
        {
          title: "Trained on fitness. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'gyms' landing page. Neverr is trained on gym workflows — goal qualification, tour booking, class waitlist management, member recognition.",
        },
        {
          title: "Flat-rate. No per-call during the January resolution surge.",
          body: "Your bill in January looks like your bill in August.",
        },
        {
          title: "Plugs into Mindbody/Glofox/Momence/TeamUp via Zapier.",
          body: "No need to switch your gym management platform.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the gym management software you already run.",
      body: STANDARD_INTEGRATION_BODY("gym and fitness studio management software"),
      examples: ["Mindbody", "ABC Glofox", "TeamUp", "Momence", "Wodify", "Zen Planner"],
    },
    close: {
      headline: "Stop losing your January resolution leads to the gym that picks up.",
      subhead: "7-day free trial, sub-second answer, tour booking from call one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Gyms — AI Receptionist for Tours, Class Booking, Member Retention",
      description:
        "Gym-trained AI receptionist with tour booking, class waitlist management, membership retention flows. Integrates with Mindbody, Glofox, Momence via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "nail-salons",
    name: "Nail Salons",
    category: "hospitality-lifestyle",
    emoji: "💅",
    featured: false,
    shortPitch: "Service-specific booking, technician matching, walk-in triage, deposits.",
    hero: {
      headline: "Never miss a booking call during your dinner rush.",
      subhead:
        "Neverr is the AI receptionist trained for nail salons. It books appointments by service and technician, handles walk-in vs. booking inquiries, takes deposits to lock spots, and books directly into Booksy, Vagaro, Mangomint, Boulevard, or Mindbody — sub-second answer, bilingual native.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it books a gel mani during a busy Saturday",
    },
    pain: [
      {
        title: "It can't tell a gel manicure from a full set acrylic.",
        body: "Gel mani is 45 minutes; full set acrylic is 90+; pedicure plus mani is 75; nail art adds 15-30. Generic AI books 'appointment' and your tech finds out at noon Saturday that the 45-minute slot is actually a 90-minute job.",
      },
      {
        title: "It can't match clients to their preferred technician.",
        body: "Repeat clients book with the same tech. Generic AI doesn't know that. The client who's been seeing Linda for 3 years gets booked with someone new, doesn't say anything at the salon, and quietly stops coming back.",
      },
      {
        title: "It loses your walk-in revenue.",
        body: "A walk-in calls to ask 'do you have anything in the next hour?' Generic AI says 'let me check' and never gets back to them — they walk in to your competitor instead.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a Saturday afternoon call.",
      setup: "Saturday, 1:47 PM. Regular client wants her gel mani with Linda, plus nail art.",
      transcript: [
        { speaker: "Neverr", text: "Polish Lounge, this is the booking line. Hi Sarah — looks like you're due for your gel?" },
        { speaker: "Caller", text: "Yes! Can I get in with Linda this afternoon? Maybe with some art if she has time." },
        {
          speaker: "Neverr",
          text: "Linda has 3:30 PM open. With nail art that's a 65-minute slot — works fine. The gel mani is your usual $50, art runs $15 to $25 depending on complexity. Want me to book the full hour to give Linda time?",
        },
        { speaker: "Caller", text: "Yes please. Probably mid-range art, like floral on the accent nails." },
        {
          speaker: "Neverr",
          text: "Booked — 3:30 PM with Linda, 65 minutes, gel mani plus floral art on accents, around $70 total. We require a $20 deposit on bookings of 60+ minutes — fully applied to your service. I'll text you a secure link.",
        },
        { speaker: "Caller", text: "Sounds good." },
      ],
      durationLabel: "Duration: 1:42",
      handoffMarkers: [
        "APPOINTMENT BOOKED in Booksy via Zapier — Sarah K., 3:30 PM Saturday",
        "Tech: Linda (client's regular)",
        "Service: Gel mani + nail art (65 min, ~$70 total)",
        "Deposit: $20 SMS link sent",
        "Confirmation text scheduled",
      ],
      caption:
        "Under two minutes. Regular recognized, booked with her preferred tech, correct service duration locked in, deposit collected — all while front desk took payment.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number." },
      {
        step: "02",
        title: "Tell us about your salon (~5 minutes)",
        body: "Pick 'Nail Salon' — we pre-load the playbook. Add service menu (durations + pricing per service), techs and their specializations, walk-in policies, deposit rules, language preferences. Connect Booksy/Vagaro/Mangomint via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Service-specific booking with tech matching.",
      },
    ],
    whatItHandles: [
      "Service-specific booking with correct duration matching (basic mani, gel, acrylic, dip, pedi, combos + nail art)",
      "Technician matching for repeat clients (recognized by phone number)",
      "Walk-in availability triage with realistic timing",
      "Deposit collection during the call (secure SMS link, $20-50 typical)",
      "Cancellation and reschedule handling",
      "Pricing communication anchored to your menu",
      "Special occasion handling (weddings, prom — flagged for tech assignment + extra time)",
      "Retail product inquiries",
      "Bilingual handling — English and Spanish from day one (Vietnamese on the roadmap)",
      "Live transfer for complaints, complex issues",
      "Spam filtering — extended-warranty, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the appointment is the start. The platform fills empty chairs, brings clients back, and turns one-time visits into rebooking habits.",
      blocks: [
        {
          title: "Recovery campaigns for clients who haven't been back.",
          body: "Most salons have hundreds of past clients who came once or twice and never returned. Neverr's recovery campaigns automatically re-engage with personalized outreach ('Hi Sarah, it's been 8 weeks — Linda has Saturday 2 PM open if you want your gel'), segmented by their preferred service and tech.",
        },
        {
          title: "Confirmation + reminder sequences cut no-shows.",
          body: "T-48h confirmation, T-24h reminder, T-2h day-of text, with one-tap confirm or reschedule. Combined with deposit collection at booking, no-show rates drop 40-60%.",
        },
        {
          title: "Client profiles that recognize regulars and their preferences.",
          body: "The client who always books gel with Linda, prefers the gel polish brand you carry in pinks, and brings her daughter for kids' manicures every other month. Neverr's caller profile surfaces all of that on call connect.",
        },
        {
          title: "Walk-in availability live updates.",
          body: "A walk-in calls asking 'do you have time today?' Neverr checks live tech availability (via your booking software), gives a realistic answer, and books on the spot if there's room.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for nail services. Priced predictably. Bilingual native.",
      blocks: [
        {
          title: "Trained on nail services. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools. Neverr knows the difference between a gel mani and a full set, between basic art and complex nail art, between a walk-in and a booking.",
        },
        {
          title: "Flat-rate.",
          body: "No per-call surcharges during your busy weekend.",
        },
        {
          title: "Plugs into Booksy/Vagaro/Mangomint/Mindbody/Boulevard via Zapier.",
          body: "No vendor switch required.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the booking software you already use.",
      body: STANDARD_INTEGRATION_BODY("nail salon booking software"),
      examples: ["Booksy", "Vagaro", "Mangomint", "Mindbody", "Boulevard", "GlossGenius", "Square Appointments"],
    },
    close: {
      headline: "Stop losing your walk-in revenue to the salon down the street.",
      subhead: "7-day free trial, technician matching from call one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Nail Salons — AI Receptionist with Service-Specific Booking",
      description:
        "Nail salon-trained AI receptionist with service+technician matching, walk-in triage, deposit collection, and bilingual support. Integrates with Booksy, Vagaro, Mangomint via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "barbershops-hair-salons",
    name: "Barbershops & Hair Salons",
    category: "hospitality-lifestyle",
    emoji: "✂️",
    featured: false,
    shortPitch: "Cut + color booking, stylist matching, deposits on color services.",
    hero: {
      headline: "Never miss a Saturday morning booking call again.",
      subhead:
        "Neverr is the AI receptionist trained for barbershops and hair salons. It books cuts, color, and combo services with the right stylist, handles walk-in inquiries, takes deposits for color services, and books directly into Booksy, Square, Vagaro, or Mangomint — sub-second answer, no chair interruption.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it books a balayage consultation",
    },
    pain: [
      {
        title: "It can't book color services correctly.",
        body: "A balayage is 3-4 hours. A root touchup is 90 minutes. A full color correction needs a 30-minute consultation first. A blowout add-on adds 30 minutes. Generic AI books 'color appointment' and your stylist discovers the conflict at 9 AM.",
      },
      {
        title: "It can't match clients to their preferred stylist.",
        body: "Hair is intimate. Clients trust the stylist who knows their hair history. Generic AI doesn't know who Sarah's stylist is. Sarah gets booked with someone new, doesn't complain, and quietly switches salons.",
      },
      {
        title: "It loses your walk-in barber revenue.",
        body: "Walk-in culture is huge in barbershops. A guy calls Saturday morning: 'you guys booked solid?' Generic AI says 'let me check' and never gets back to him. He goes to the shop down the street.",
      },
    ],
    proof: {
      title: "Watch Neverr book a balayage consultation.",
      setup: "Tuesday, 6:23 PM. New client calling about balayage, has never been to the salon.",
      transcript: [
        { speaker: "Neverr", text: "Salon Atelier, this is the booking line. How can I help?" },
        { speaker: "Caller", text: "Hi, I'm interested in getting a balayage. I've never been to your salon — what's the process?" },
        {
          speaker: "Neverr",
          text: "For first-time balayage, we have you do a 30-minute consultation first — it's complimentary. Our senior colorist Maria reviews your hair, takes photos for reference, and gives you the exact pricing for your hair type. The actual balayage service runs 3 to 3.5 hours and is typically $250 to $400 depending on hair length and complexity. Would you like to book a consultation?",
        },
        { speaker: "Caller", text: "Yes please. Are you available Saturday?" },
        {
          speaker: "Neverr",
          text: "Maria has Saturday at 11 AM open for the consultation. After your consult, she can book your balayage service for the following weekend if you're ready to move forward. To hold the consultation slot we ask for a $50 deposit, which applies to either the consult or your balayage service. I'll text you a secure payment link.",
        },
        { speaker: "Caller", text: "Sounds great." },
      ],
      durationLabel: "Duration: 1:58",
      handoffMarkers: [
        "CONSULTATION BOOKED in Vagaro via Zapier — Saturday 11 AM with Maria (senior colorist)",
        "Service flow: 30-min complimentary consult → balayage booking",
        "Deposit: $50 SMS link sent (applies to consult or service)",
        "Pricing communicated honestly: $250-400 balayage range",
        "Pre-arrival prep instructions text scheduled",
      ],
      caption:
        "Under two minutes. Color-service-aware booking, consultation requirement enforced for first-timers, honest pricing range, deposit captured via secure SMS link.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number." },
      {
        step: "02",
        title: "Tell us about your salon (~5 minutes)",
        body: "Pick 'Hair Salon' — we pre-load the playbook. Add service menu, stylists and specializations (men's vs. women's, color, balayage, beard service), walk-in policies, deposit rules per service type. Connect Booksy/Square/Vagaro via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Cut + color booking with stylist matching.",
      },
    ],
    whatItHandles: [
      "Cut booking with stylist matching (clients recognized by phone)",
      "Color service booking with proper time blocks (root touchup, full color, balayage, highlights, color correction)",
      "Consultation requirement enforcement for color correction and major changes",
      "Combo service booking (cut + color, color + treatment, etc.)",
      "Beard service for barbershops (line up, beard trim, straight razor shave, beard color)",
      "Walk-in availability live updates",
      "Deposit collection on color services (secure SMS link, $25-100 depending on service)",
      "Special occasion bookings (weddings, prom, photoshoot — flagged with extra time + senior stylist)",
      "Retail product inquiries",
      "Bilingual handling (English/Spanish from day one)",
      "Live transfer for complaints, complex color consultations, VIP clients",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the cut is the start. The platform brings clients back on the right cycle, fills color slots, and recognizes your regulars.",
      blocks: [
        {
          title: "Rebooking sequences keep clients on cycle.",
          body: "Men's cuts run 3-5 week cycle. Women's cuts run 6-10 weeks. Color clients run 6-12 weeks for root touchup. When clients fall off cycle, they often try a different salon. Neverr's SMS sequences automatically prompt rebooking at the right cadence.",
        },
        {
          title: "Recovery campaigns for clients who haven't been back.",
          body: "Beyond the cycle, every salon has hundreds of clients who came once or a few times and never returned. Neverr's recovery campaigns reach out with personalized outreach segmented by service history and stylist preference.",
        },
        {
          title: "Client profiles surface chair-side context.",
          body: "The client who always books with Carlos, prefers fade #2 on the sides. The color client whose formula is documented. Neverr surfaces all of it on call connect. The relationship that made them yours stays yours.",
        },
        {
          title: "No-show reduction with deposits + reminder sequences.",
          body: "For color services especially — where a no-show costs the colorist 3-4 hours of revenue — Neverr collects deposits during the booking call, sends T-48h/T-24h/T-2h reminders, and surfaces unconfirmed appointments in your morning prep view.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for hair. Priced predictably. Bilingual native.",
      blocks: [
        {
          title: "Trained on hair. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools. Neverr knows the difference between a fade and a balayage, between a root touchup and a full color, between a walk-in barber call and a women's color consultation.",
        },
        {
          title: "Flat-rate.",
          body: "No per-call surcharges during your busy weekend.",
        },
        {
          title: "Plugs into Booksy/Square/Vagaro/Mangomint/Mindbody/Boulevard via Zapier.",
          body: "No vendor switch required.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the booking software you already use.",
      body: STANDARD_INTEGRATION_BODY("hair salon and barbershop booking software"),
      examples: ["Booksy", "Square Appointments", "Vagaro", "Mangomint", "Mindbody", "Boulevard", "GlossGenius"],
    },
    close: {
      headline: "Stop losing your Saturday walk-ins to the next shop on the block.",
      subhead: "7-day free trial, stylist matching from call one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Barbershops & Hair Salons — AI Receptionist with Stylist Matching",
      description:
        "Hair-trained AI receptionist with cut+color booking, stylist matching, deposit collection on color services, and walk-in triage. Integrates with Booksy, Square, Vagaro via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "tag-services",
    name: "Tag Services",
    category: "auto-transport",
    emoji: "📋",
    featured: false,
    shortPitch: "Document checklist answers, service availability, bilingual native.",
    hero: {
      headline: "Never miss a 'what do I need to bring?' call again.",
      subhead:
        "Neverr is the AI receptionist trained for tag agencies. It answers the documentation questions your front desk gets asked 50 times a day, books appointments where you offer them, gives accurate pricing for every service, and routes complex transactions to your team — sub-second answer, bilingual from day one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it answers a Florida new-resident registration question",
    },
    pain: [
      {
        title: "It can't answer the document checklist questions.",
        body: "'I'm registering a vehicle from out of state — what do I need?' 'I'm doing a title transfer between family members — what's required?' 'I have a registration hold from MDX tolls — can you clear it?' These are the calls your front desk gets dozens of times a day. Generic AI doesn't know the answers.",
      },
      {
        title: "It can't tell apart your services from the DMV's services.",
        body: "Customers don't know what tag agencies do. They call asking about driver's license renewals (which you mostly don't do), then hang up confused. Generic AI doesn't help — it just records messages your team has to return.",
      },
      {
        title: "It interrupts your in-office service.",
        body: "Your team is processing a customer at the counter when the phone rings. Every interruption is a service-quality hit. Generic AI just rolls calls to voicemail; your team plays catch-up at end of day.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a new-Florida-resident registration question.",
      setup: "Wednesday, 11:22 AM. Customer recently moved from out of state, calling to ask about vehicle registration.",
      transcript: [
        { speaker: "Neverr", text: "Sunshine Tag Agency, this is the service line. How can I help?" },
        { speaker: "Caller", text: "Hi, I just moved to Florida from Texas. I need to register my car here. What do I need to bring?" },
        {
          speaker: "Neverr",
          text: "Welcome to Florida! For new-resident vehicle registration, here's the checklist: your Florida driver's license or state ID, the original signed title from Texas, your current insurance card from a Florida-licensed insurer, a signed bill of sale if you bought the car from a private seller (not needed if it's been your car for a while), and the vehicle itself for VIN verification. We can also register the car if it's still under loan — we'll need the lienholder info and the title from your lender. Do you have all of those?",
        },
        { speaker: "Caller", text: "I have everything except the Florida insurance — my Texas insurance is still active." },
        {
          speaker: "Neverr",
          text: "You'll need to switch to a Florida-licensed insurer before we can register the vehicle — Florida law requires it. Most major insurers (Geico, State Farm, Progressive, Allstate) have Florida policies you can switch to in about 15 minutes online. Once you have your new Florida insurance card, you're ready to come in. Our pricing for new-resident registration is the state fee (varies based on vehicle weight, typically $225-$375) plus our $25 service fee. Do you want me to text you the full checklist so you have it for reference?",
        },
        { speaker: "Caller", text: "Yes please. Do I need an appointment?" },
        {
          speaker: "Neverr",
          text: "We're walk-in for new-resident registration — no appointment needed. Average wait time today is about 20 minutes. We're open until 5 PM.",
        },
      ],
      durationLabel: "Duration: 2:34",
      handoffMarkers: [
        "Document checklist text sent — full new-resident registration requirements",
        "Pricing communicated: state fee $225-$375 + $25 agency service fee",
        "Walk-in confirmed — no appointment needed",
        "Common pitfall flagged: out-of-state insurance not accepted",
        "Customer profile created in agency CRM via webhook for follow-up if no-show",
      ],
      caption:
        "Two minutes, thirty-four seconds. New-resident question answered correctly with full document checklist, common pitfall (out-of-state insurance) flagged, pricing transparent, walk-in policy confirmed — without your team stepping away from the counter.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number." },
      {
        step: "02",
        title: "Tell us about your services (~10 minutes)",
        body: "Pick 'Tag Agency' — we pre-load the playbook. Add your services (registration renewal, title transfers, fast title, boat/vessel, dealer services, disabled parking permits), pricing per service, appointment vs. walk-in policy per location, hours, accepted payment methods.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Live answer, document checklist answers, sync to your scheduling system via Zapier or webhook.",
      },
    ],
    whatItHandles: [
      "Document checklist answers per service type (new resident, title transfer, vessel registration, dealer transactions)",
      "Service availability triage (yes we do that / no, that's DMV-only)",
      "Pricing communication (state statutory fees + agency service fee, broken out)",
      "Appointment booking where you offer them",
      "Walk-in availability and wait time estimates",
      "Hold/stop clearance protocol explanation (toll invoices, parking violations, child support holds)",
      "Specialty plate inquiries with options menu",
      "Boat/vessel registration questions",
      "Fast title eligibility",
      "Dealer service routing",
      "Bilingual (English/Spanish) — critical in Florida; Vietnamese on roadmap",
      "Live transfer for complex transactions, dealer accounts, complaints",
      "Spam filtering — extended-warranty, lead-gen scrapers, fake 'DMV' robocalls killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Answering the call is the start. The platform brings repeat customers back, captures dealer accounts, and turns first-time customers into loyalty.",
      blocks: [
        {
          title: "Renewal reminder campaigns for repeat customers.",
          body: "Vehicle registration renewals happen annually or every two years. Most customers wait until their registration is about to expire — or expires — before scrambling. Neverr's SMS sequences proactively remind customers 60 and 30 days before renewal ('Your Florida registration expires next month — book your renewal at our Hollywood office'), with one-tap booking or walk-in info.",
        },
        {
          title: "Dealer service relationships — captured, not lost.",
          body: "Auto and boat dealers are recurring high-value B2B customers. Neverr captures structured intake (dealer name, license number, transaction volume, services needed, point of contact) and creates a lead in your dealer CRM with full context.",
        },
        {
          title: "Customer profiles that surface history on call connect.",
          body: "The customer who's renewed three years in a row at your agency. The dealer who processes 40 transactions a month with you. Neverr surfaces their service history on call, applies any account-specific pricing, and routes them to the right counter.",
        },
        {
          title: "Multi-location support for tag agency groups.",
          body: "For agency operators with 2-15 locations (common in Florida), Neverr handles centralized intake with location-specific routing. Each office has its own services, hours, appointment policies, and pricing — but the platform is one.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for tag agencies. Priced predictably. Bilingual native.",
      blocks: [
        {
          title: "Trained on tag-and-title workflows. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools. Neverr knows the document checklists for every common transaction, the difference between agency services and DMV-only services, the pricing breakdown of state fees vs. agency fees.",
        },
        {
          title: "Flat-rate pricing.",
          body: "No per-call surcharges during renewal-month surges.",
        },
        {
          title: "Bilingual native (essential for Florida market).",
          body: "Spanish from day one. Vietnamese on the roadmap.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into your scheduling and document systems.",
      body: STANDARD_INTEGRATION_BODY("tag agency systems (note: tag agency software is fragmented; we integrate via Zapier or custom webhook with whatever you use)"),
      examples: ["Standard Google Calendar", "Microsoft Outlook", "Zapier (5,000+ apps)", "Custom webhook for proprietary systems"],
    },
    close: {
      headline: "Stop losing customers to the DMV because they didn't know what to bring.",
      subhead: "7-day free trial, document checklist answers from call one, bilingual native.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Tag Agencies — AI Receptionist with Document Checklist + Bilingual Support",
      description:
        "Tag agency-trained AI receptionist that answers document checklist questions, gives accurate service pricing, handles renewal reminders, and supports bilingual (English/Spanish) callers. Try free for 7 days.",
    },
  },

  {
    slug: "rental-cars",
    name: "Rental Car Companies",
    category: "auto-transport",
    emoji: "🚗",
    featured: false,
    shortPitch: "Independent + specialty (exotic, luxury, RV) — availability, deposits, delivery.",
    hero: {
      headline: "Never miss another weekend booking call.",
      subhead:
        "Neverr is the AI receptionist trained for independent and specialty rental car operators. It checks vehicle availability, explains insurance and deposit requirements, takes deposits during the call, and books delivery — sub-second answer, weekend-pricing-aware, no after-hours leakage to your competition.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a Friday afternoon Lamborghini inquiry",
    },
    pain: [
      {
        title: "It can't explain insurance requirements.",
        body: "Exotic and luxury rentals require full coverage transfer, not just the renter's standard policy. RV rentals have special insurance considerations. Generic AI says 'we'll need your insurance info' and the caller doesn't know what that means.",
      },
      {
        title: "It can't handle weekend pricing complexity.",
        body: "Most independent rental operators have weekend minimums (2-3 days), peak event pricing, holiday rates, multi-day discounts. Generic AI quotes a daily rate and the caller is shocked when the actual quote comes back at 3x.",
      },
      {
        title: "It loses your highest-revenue inquiry window.",
        body: "Friday 4-8 PM is when leisure renters research the weekend. Your office is closed or your one staff member is helping a walk-in. The motivated weekend renter calls 5 operators. The first to answer with real availability and pricing wins the booking — often a $1,500-$5,000 weekend rental.",
      },
    ],
    proof: {
      title: "Watch Neverr lock a Lamborghini Huracan weekend booking.",
      setup: "Friday, 6:23 PM. Caller wants a Huracan for Saturday-Sunday.",
      transcript: [
        { speaker: "Neverr", text: "Apex Exotic Rentals, this is the booking line. How can I help?" },
        { speaker: "Caller", text: "Hey, I want to rent a Lamborghini Huracan for this weekend, Saturday and Sunday. Possible?" },
        {
          speaker: "Neverr",
          text: "Yes — we have one Huracan available for Saturday and Sunday. We have a 2-day weekend minimum so that works perfectly. Our weekend rate on the Huracan is $1,599 per day, so $3,198 plus tax for the two days. To secure the booking we need a $500 deposit, and the remainder is due day-of pickup. Are you 24 or older with full coverage insurance?",
        },
        { speaker: "Caller", text: "Yeah I'm 32. I have State Farm full coverage on my Tesla." },
        {
          speaker: "Neverr",
          text: "Perfect. Your existing State Farm policy can typically be extended to cover the rental — you'll need to call them and add the Huracan as a temporary rental on your policy with $300K liability minimum. Most policies can do this online or over the phone in 10 minutes; we need confirmation 24 hours before pickup. Want me to lock the booking now and text you the deposit link?",
        },
        { speaker: "Caller", text: "Yes, let's do it." },
      ],
      durationLabel: "Duration: 2:51",
      handoffMarkers: [
        "BOOKING CREATED in HQ Rental Software via Zapier — Lamborghini Huracan, Sat-Sun",
        "Booking value: $3,198 + tax (2 days × $1,599)",
        "Deposit: $500 SMS link sent (Stripe-backed)",
        "Insurance requirement: customer's State Farm policy — must add Huracan + $300K liability",
        "Pickup instructions text scheduled (24 hours before)",
        "Insurance verification reminder scheduled (T-24h)",
      ],
      caption:
        "Under three minutes. $3,198 weekend rental locked, deposit captured via secure SMS link, insurance requirements explained clearly, pickup instructions queued — while your office was closed.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number." },
      {
        step: "02",
        title: "Tell us about your fleet (~10 minutes)",
        body: "Pick 'Rental' — we pre-load the playbook. Add your fleet (vehicle list, daily rates, weekend pricing, mileage limits, age requirements), insurance requirements per vehicle class, deposit policies, delivery zones and fees, peak event pricing rules.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Fleet sync via Zapier or webhook.",
      },
    ],
    whatItHandles: [
      "Real-time vehicle availability check (per vehicle, per date range)",
      "Pricing communication including weekend minimums, multi-day discounts, peak event pricing",
      "Insurance requirement explanation (coverage levels, transfer process, required documents)",
      "Deposit collection during the call (secure SMS link, $200-$1,000+ depending on vehicle class)",
      "Age and license requirement enforcement (24+, 28+ for some exotics; international license verification)",
      "Delivery coordination (location, timing, fees, hotel/airport pickup)",
      "Multi-day rental booking with full pricing breakdown",
      "Special event packages (prom, wedding, photoshoot, concert)",
      "Cancellation and modification policy enforcement",
      "Returning client recognition via phone-number lookup",
      "Bilingual handling (English/Spanish from day one)",
      "Live transfer for negotiation, complex multi-vehicle bookings, complaints",
      "Spam filtering — scam booking attempts, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the rental is the start. The platform brings repeat clients back, fills off-peak weekends, and captures the event business.",
      blocks: [
        {
          title: "Recovery campaigns for past renters.",
          body: "Most operators have hundreds of past clients who rented once for an event and never came back. Neverr's recovery campaigns automatically re-engage with personalized outreach ('Hi Mike, prom season is coming — the Aston Martin you rented last year is available again').",
        },
        {
          title: "Off-peak weekend fill campaigns.",
          body: "Specialty rental fleets sit idle on weekdays and shoulder-season weekends. Neverr can run promotional SMS campaigns to past clients ('This weekend's Ferrari is open at 20% off — first to book'), driving incremental utilization.",
        },
        {
          title: "Caller profiles that recognize VIP renters.",
          body: "The client who's rented from you 5 times. The corporate account that does monthly rentals. The wedding planner who's booked you for 8 client weddings. Neverr surfaces their full history, applies any account-specific pricing.",
        },
        {
          title: "Multi-location support for fleet operators.",
          body: "For operators with 2+ locations or fleet partners, Neverr handles centralized intake with location-specific routing. Each location has its own fleet, pricing, delivery zones — but the platform is one.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for rental. Priced predictably. Deposit-collection-during-call.",
      blocks: [
        {
          title: "Trained on rental. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools. Neverr knows weekend minimums, peak event pricing, insurance transfer protocols, age requirements per vehicle class.",
        },
        {
          title: "Flat-rate.",
          body: "No per-call surcharges during prom or wedding season surges.",
        },
        {
          title: "Plugs into HQ Rental, RentSyst, Bluebird via Zapier or custom webhook.",
          body: "Your fleet management system stays the same.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into your fleet management system.",
      body: STANDARD_INTEGRATION_BODY("rental fleet management systems"),
      examples: ["HQ Rental Software", "RentSyst", "Easirent", "Bluebird Auto Rental", "RentWorks"],
    },
    close: {
      headline: "Stop letting your weekend rentals walk to the next operator.",
      subhead: "7-day free trial, deposit-collection-during-call from call one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Rental Car Companies — AI Receptionist for Exotic, Luxury, and RV Rentals",
      description:
        "AI receptionist for independent and specialty rental car operators with availability check, insurance requirement handling, deposit collection during call, and weekend pricing awareness. Try free for 7 days.",
    },
  },

  {
    slug: "virtual-offices",
    name: "Virtual Offices & Coworking",
    category: "professional-services",
    emoji: "🏢",
    featured: false,
    shortPitch: "Plan qualification, tour booking, meeting room booking, member services routing.",
    hero: {
      headline: "Never miss another tour booking — or another tenant call.",
      subhead:
        "Neverr is the AI receptionist trained for virtual office and coworking operators. It explains plans, books tours, handles meeting room reservations, and routes member inquiries — sub-second answer, native multi-language, no front desk interruption when you're showing the space.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it qualifies a virtual office prospect",
    },
    pain: [
      {
        title: "It can't tell apart your plans.",
        body: "Address-only vs. address-with-call-answering vs. address-plus-day-passes vs. full virtual office vs. coworking membership vs. dedicated desk — each has different pricing, different features, different ideal customer. Generic AI describes 'the basic plan' and the prospect is confused.",
      },
      {
        title: "It interrupts your tours.",
        body: "Your one staff member is showing the space to a walk-in tour. The phone rings. They can't pick up — they're with a $300/month prospect. The phone caller (also a $300/month prospect) hangs up after 4 rings. Both losses compound.",
      },
      {
        title: "It can't handle meeting room bookings.",
        body: "Members and walk-ins call asking about meeting room availability for tomorrow morning, for an afternoon client meeting, for an all-day workshop. Generic AI doesn't know your live booking calendar.",
      },
    ],
    proof: {
      title: "Watch Neverr qualify a virtual office prospect.",
      setup: "Wednesday, 11:15 AM. Solo founder calling about virtual office options for his startup.",
      transcript: [
        { speaker: "Neverr", text: "Midtown Workspace, this is the membership line. How can I help?" },
        { speaker: "Caller", text: "Hi, I have a small startup and I'm looking at virtual office options. What do you offer?" },
        {
          speaker: "Neverr",
          text: "Happy to help you pick the right fit. Quick questions: do you mostly need a prestige business address for client mail and registered agent service, or do you also need physical workspace some days, or call answering for your business?",
        },
        { speaker: "Caller", text: "Definitely need the address for clients. We get phone calls maybe 5-10 a week. I work from home most days but it'd be nice to have a place I could go occasionally." },
        {
          speaker: "Neverr",
          text: "Sounds like our Pro Virtual Office is the fit — $199/month. Includes prestige Midtown business address, mail handling and forwarding, registered agent service, professional call answering for incoming business calls, and 4 day-passes per month to use our coworking space when you want a change of scenery. Would you like to come in for a tour to see the space?",
        },
        { speaker: "Caller", text: "Yes, that sounds perfect. Can I come this week?" },
        {
          speaker: "Neverr",
          text: "We have Friday at 2 PM with our membership lead, Marcus, or Thursday at 4 PM with Sarah. Both can show you the workspace and walk you through how the call answering works.",
        },
        { speaker: "Caller", text: "Friday at 2 works." },
      ],
      durationLabel: "Duration: 2:34",
      handoffMarkers: [
        "TOUR BOOKED in Optix via Zapier — Friday 2 PM with Marcus",
        "Lead profile: virtual office, mail + call answering needs, 4-pass coworking add-on",
        "Recommended plan: Pro Virtual Office ($199/mo)",
        "Plan info text scheduled — 2 minutes",
        "Marcus notified of tour with full lead context",
      ],
      caption:
        "Two minutes, thirty-four seconds. Plan-qualified prospect, recommended the right tier, tour booked with the membership lead — without your front desk stepping away from showing another tour.",
    },
    howItWorks: [
      { step: "01", title: "Sign up (~60 seconds)", body: "Email + phone number." },
      {
        step: "02",
        title: "Tell us about your space (~10 minutes)",
        body: "Pick 'Virtual Office / Coworking' — we pre-load the playbook. Add your plans (with pricing per tier), tour availability, meeting room inventory + booking rules, day-pass policies, mail handling, member services protocols.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Live answer, sync to Optix/Nexudus/Cobot/OfficeRnD via Zapier.",
      },
    ],
    whatItHandles: [
      "Plan qualification and recommendation (address-only / virtual office / coworking / dedicated desk / private office)",
      "Tour booking with calendar awareness",
      "Meeting room reservation with live availability",
      "Day-pass inquiries and booking",
      "Mail forwarding policy and process explanation",
      "Registered agent service inquiries",
      "Member services routing (existing members get different handling than prospects)",
      "Multi-language native (English/Spanish + others on roadmap)",
      "Live transfer for negotiation, complex enterprise inquiries, complaints",
      "Spam filtering — extended-warranty robocalls, unsolicited B2B prospecting calls killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead: "Booking the tour is one use case. There's a bigger opportunity hiding in plain sight.",
      blocks: [
        {
          title: "Use Neverr as a tenant service to differentiate your offering.",
          body: "Most virtual office operators bundle 'call answering' as a value prop — typically a human receptionist who can handle 30-50 member calls per day. With Neverr, you can offer your members AI-powered call answering as a premium tier — every member gets sub-second answer in their company's name, professional intake, message routing, calendar booking. You charge a premium for it; we power it.",
        },
        {
          title: "Recovery campaigns for past tours that didn't convert.",
          body: "Most operators have dozens of past tours every quarter who didn't sign. Neverr's recovery campaigns automatically re-engage past tour prospects ('Hi Sarah, you toured our Midtown space in March — we have spring move-in incentives available'), segmented by which plan they were considering.",
        },
        {
          title: "Member profiles for personalized handling.",
          body: "Existing members calling about meeting rooms, mail, tech issues, or upgrades — Neverr surfaces their member profile (plan, length of tenure, last interactions, any flagged notes), applies the right service protocol, and routes correctly.",
        },
        {
          title: "Multi-location support for operators with 2+ spaces.",
          body: "Neverr handles centralized intake with location-specific routing — calls about the Midtown space go to Midtown protocols, calls about the Brooklyn space go to Brooklyn protocols. Tour booking, meeting room availability, and member services are all location-aware.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for virtual offices. Priced predictably. Reseller-friendly.",
      blocks: [
        {
          title: "Trained on virtual office workflows. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools. Neverr knows the difference between an address-only plan and a virtual office, between a tour and a member service call, between a day-pass walk-in and a tenant.",
        },
        {
          title: "Flat-rate.",
          body: "No per-call surcharges. Predictable monthly bill.",
        },
        {
          title: "Plugs into Optix/Nexudus/Cobot/OfficeRnD via Zapier.",
          body: "Your member management platform stays the same.",
        },
        {
          title: "Reseller-friendly.",
          body: "Talk to us about offering Neverr to your members as a premium tier — you charge, we power.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the tools you already use.",
      body: STANDARD_INTEGRATION_BODY("coworking and virtual office management software"),
      examples: ["Optix", "Nexudus", "Cobot", "OfficeRnD", "andcards", "Coworks", "Yardi Kube"],
    },
    close: {
      headline: "Stop letting your tours interrupt your member calls. Or vice versa.",
      subhead: "7-day free trial, plan qualification from call one. Reseller conversation available.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Virtual Offices & Coworking — AI Receptionist for Tours, Meetings, Member Services",
      description:
        "Virtual office and coworking AI receptionist with plan qualification, tour booking, meeting room reservation, member services routing. Integrates with Optix, Nexudus, Cobot via Zapier. Try free for 7 days.",
    },
  },
  // ==========================================================================
  // WAVE 2 — Healthcare + Home Services expansion (added 2026-05-05)
  // ==========================================================================
  {
    slug: "chiropractors",
    name: "Chiropractors",
    category: "health-wellness",
    emoji: "🦴",
    featured: true,
    shortPitch:
      "Insurance triage, PI/LOP referral capture, care-plan recall, HIPAA + signed BAA.",
    hero: {
      headline: "Never miss another new-patient call from a PI attorney referral.",
      subhead:
        "Neverr is the AI receptionist trained for chiropractic. It books visits with the right doctor and the right time block, handles insurance verification triage, captures personal-injury and workers-comp referrals correctly, and runs the recall sequences that keep care plans on track — sub-second answer, HIPAA + BAA from day one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a PI referral after-hours",
    },
    pain: [
      {
        title: "It can't tell a wellness visit from a PI case.",
        body: "A patient calling about back pain after a routine workout needs a 20-minute adjustment slot. A patient who was rear-ended yesterday needs an hour-plus initial exam, an attorney intake, and the right diagnostic codes from minute one. Generic AI books 'appointment' and your front desk discovers the difference at 9 AM Monday — when the PI case has already called another clinic.",
      },
      {
        title: "It can't run insurance triage.",
        body: "Aetna covers 20 visits a year. Blue Cross requires a referral. Medicare has different rules than Medicare Advantage. PI cases are LOPs (Letters of Protection), not insurance. Generic AI can't tell these apart, books everyone the same way, and your billing team plays cleanup all week.",
      },
      {
        title: "It loses your overdue patients to inertia.",
        body: "Every clinic has hundreds of patients who started a 12-visit care plan, completed 6, then drifted. They meant to come back. Generic AI doesn't know they exist. The patient feels better for a few weeks, doesn't call, and you lose the second half of their treatment plan plus their family's future visits.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a PI attorney referral after-hours.",
      setup:
        "Tuesday, 7:24 PM. Practice closed at 6 PM. Patient is a new prospect, rear-ended in a car accident yesterday, was given the practice's name by a personal-injury attorney.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Bayside Chiropractic, this is the after-hours line. How can I help?",
        },
        {
          speaker: "Caller",
          text: "Hi, I was in a car accident yesterday. My attorney, Mr. Hartman, told me to call your office to get evaluated.",
        },
        {
          speaker: "Neverr",
          text: "I'm so sorry that happened to you, and I'm glad Mr. Hartman sent you our way — Dr. Patel works with him often. Let's get you scheduled. First, are you in pain right now or able to move okay?",
        },
        {
          speaker: "Caller",
          text: "My neck and lower back are really stiff. Some shooting pain down my right leg.",
        },
        {
          speaker: "Neverr",
          text: "That sounds consistent with what we see after rear-impact collisions — Dr. Patel will want to do a full exam, X-rays if indicated, and document everything. Have you been seen at a hospital or urgent care since the accident?",
        },
        {
          speaker: "Caller",
          text: "I went to the ER last night. They did X-rays, said no fractures, gave me muscle relaxers and told me to follow up with a chiropractor or my primary.",
        },
        {
          speaker: "Neverr",
          text: "Good — bring those ER records and the X-ray disc with you if you have them. Since this is a personal injury case under Mr. Hartman's office, we'll bill on a Letter of Protection — no out-of-pocket from you. I'll need your full name, date of birth, the accident date, and the at-fault driver's insurance carrier if you have it.",
        },
        {
          speaker: "Caller",
          text: "Maria Lopez, 4-12-1985. Accident was yesterday morning, around 9 AM. The other driver had Geico.",
        },
        {
          speaker: "Neverr",
          text: "Got it. We have tomorrow morning at 8:30 with Dr. Patel for your initial exam — 60 minutes, full intake plus X-rays in our office if he needs them. Mr. Hartman's office will get a copy of all records for your case file. Sound good?",
        },
        { speaker: "Caller", text: "Yes please." },
        {
          speaker: "Neverr",
          text: "Booked for tomorrow 8:30 AM. I'll text you a secure link to our intake forms — please fill them out tonight if you can, it'll save 20 minutes in the morning. And if your pain gets significantly worse overnight or you have any new symptoms like numbness or weakness, please go back to the ER.",
        },
      ],
      durationLabel: "Duration: 3:24",
      handoffMarkers: [
        "NEW PATIENT CHART CREATED in ChiroTouch via Zapier — Maria Lopez",
        "DOB: 4/12/1985, Source: PI Attorney Referral (Hartman Law Group)",
        "Case type: PERSONAL INJURY — Letter of Protection billing",
        "Accident: yesterday, rear-impact collision",
        "At-fault carrier: Geico (for subrogation/billing record)",
        "ER triage prior: yes (no fractures, muscle relaxers Rx'd)",
        "Appointment: Tomorrow 8:30 AM, Dr. Patel, NP Exam (60 min, w/ X-ray)",
        "Intake forms: HIPAA-compliant SMS link sent",
        "Attorney notification queued: records release + case file copy",
        "Red-flag instructions delivered: ER return on neuro symptoms",
      ],
      caption:
        "Three minutes, twenty-four seconds. New PI patient correctly identified as LOP (not insurance), attorney referral source captured, accident details documented, prior ER triage logged, 60-minute new-patient slot booked with the right doctor, red-flag neuro instructions delivered, ChiroTouch synced, attorney's office queued for records release. Mr. Hartman wakes up to a new case file already in motion.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. We sign your BAA at signup — before any patient data flows.",
      },
      {
        step: "02",
        title: "Tell us about your practice (~10 minutes)",
        body: "Pick 'Chiropractic' — we pre-load the playbook. Add your DCs, your visit types and durations (NP exam, follow-up adjustment, re-eval, modality add-ons), your insurance carriers and verification rules, your PI attorney relationships, your care plan templates, your recall cycles. Connect ChiroTouch, ChiroSpring, Genesis, Platinum, or zHealth via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Visit-type triage. Insurance vs. LOP routing. New-patient charts auto-created. Recall sequences run automatically.",
      },
    ],
    whatItHandles: [
      "Visit-type triage — NP exam, follow-up adjustment, re-eval, modality (e-stim, ultrasound, decompression, laser, massage)",
      "Insurance verification triage — flags coverage type for billing team (PPO vs. HMO vs. Medicare vs. Medicare Advantage vs. cash)",
      "PI / workers-comp / LOP routing — recognizes case type, captures attorney/adjuster contact, flags for case-file management",
      "Care plan progress awareness — patient on visit 6 of 12 gets different handling than first-timer",
      "Recall sequences — overdue patients (decompression series, adjustment cycles, annual re-eval) re-engaged with multi-touch SMS",
      "Family-add-on recognition — patient mentioning spouse/kids gets second-patient intake offer",
      "Workers' comp claim intake — captures employer, claim number, adjuster contact correctly",
      "Auto accident attorney referral capture — source-attributes the referring firm, queues case file workflow",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for known patients, complex insurance questions, complaints",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the visit is the start. Retention, recall, and PI relationships are where the platform compounds.",
      blocks: [
        {
          title: "Recall sequences for the patients who didn't finish their care plan.",
          body: "Most chiropractors have hundreds of patients who started a 12-visit plan and stopped at 6 — they felt better, life got busy, the second half of treatment never happened. Neverr's SMS sequences automatically re-engage by care-plan stage ('Maria, you have 6 visits remaining on your plan — Dr. Patel has Wednesday at 11 AM open'), with replies routed back to your front desk. Patients who'd quietly disappear come back without your team chasing them.",
        },
        {
          title: "PI attorney relationship hub — cases tracked, records released, referrals counted.",
          body: "PI attorneys send referrals to clinics that make their lives easy. Neverr captures every referral by source, queues records-release workflow on case milestones, and surfaces a per-attorney dashboard showing referrals received, cases active, average treatment value. Your relationship with Mr. Hartman becomes a tracked partnership, not a series of one-off favors.",
        },
        {
          title: "Patient profiles that surface care plan context on every call.",
          body: "When the phone rings and it's a known patient, Neverr's caller profile flags them — current care plan stage, insurance status, last visit date, any flagged notes (red-flag symptoms, family-member patients, billing alerts). The AI doesn't make Mrs. Patterson re-introduce herself or re-explain that her son is also a patient.",
        },
        {
          title: "Multi-location support for chiropractic groups.",
          body: "For groups with 2-10 clinics (common in regional chiropractic groups), Neverr handles centralized intake with location-specific routing. Each clinic has its own DC roster, its own insurance contracts, its own PI attorney relationships — but the platform is one. Patients who move across locations stay with your group.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for chiropractic. HIPAA-compliant. Predictable pricing.",
      blocks: [
        {
          title: "Trained on chiropractic. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'chiropractic' landing page. They don't know that a 20-minute adjustment slot can't fit a 60-minute new-patient exam, that a Letter of Protection is billed differently than insurance, or that an active care plan patient is worth 4x a one-visit shopper. Neverr is trained specifically on chiropractic intake patterns, visit-type triage, insurance vs. LOP routing, and care-plan retention dynamics.",
        },
        {
          title: "HIPAA, BAA, and audit logging. Standard, not add-on.",
          body: "You sign our BAA at signup. All call data is encrypted in transit and at rest. Role-based access controls and full audit logging on every patient interaction. Required in chiropractic; baked into Neverr.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "The chiropractic answering service market is full of pricing traps — per-minute, per-call, per-message-relay surcharges that punish you in the busy seasons (auto-accident-heavy weeks, workers'-comp claim spikes, insurance-deadline crunches). Neverr is flat-rate. Your bill in November looks like your bill in February.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the practice management software your team already uses.",
      body: STANDARD_INTEGRATION_BODY("chiropractic practice management software"),
      examples: ["ChiroTouch", "ChiroSpring", "Genesis Chiropractic", "Platinum System", "zHealth", "ChiroFusion"],
    },
    close: {
      headline: "Stop losing $100,000+ a year to no-shows and dropped care plans.",
      subhead:
        "Chiropractic practices using AI receptionists capture 80%+ of previously missed calls, reduce no-shows 40-60%, and recover 25-30% of overdue care-plan patients. Try Neverr free for 7 days — BAA signed at signup, no card required.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Chiropractors — AI Receptionist with PI Referral Capture",
      description:
        "Chiropractic-trained AI receptionist with insurance triage, PI/LOP routing, care-plan recall sequences, and PMS integration via Zapier. HIPAA + signed BAA. Try free for 7 days.",
    },
  },

  {
    slug: "physical-therapy-clinics",
    name: "Physical Therapy Clinics",
    category: "health-wellness",
    emoji: "🏃",
    featured: true,
    shortPitch:
      "Insurance pre-auth triage, plan-of-care recall, post-op referral capture, HIPAA + signed BAA.",
    hero: {
      headline: "Never miss another post-op referral from a surgeon's office.",
      subhead:
        "Neverr is the AI receptionist trained for physical therapy. It triages by referral source and condition, runs the insurance pre-auth questions your billing team needs, books with the right PT for the right specialty, and recovers the plan-of-care patients who quietly stopped showing up — sub-second answer, HIPAA + BAA from day one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a post-op ACL referral",
    },
    pain: [
      {
        title: "It can't triage by referral source and specialty.",
        body: "A post-op ACL patient needs a sports-PT specialist and a 60-minute initial eval. A pelvic floor referral needs a women's health specialist and a private treatment room. A vestibular case needs a PT trained in vestibular rehab. Generic AI books everyone with 'next available' and your clinic director discovers the mismatch on Monday.",
      },
      {
        title: "It can't capture insurance pre-auth correctly.",
        body: "PT requires pre-auth at most insurers. The intake call is the moment to capture referring physician, NPI, ICD-10 codes from the referral, visit allotment, copay structure. Generic AI captures 'name and number.' Your billing team chases the rest, denial rates climb, revenue leaks.",
      },
      {
        title: "It doesn't bring back plan-of-care drop-offs.",
        body: "Every PT clinic has patients who completed 4 of 12 prescribed visits and drifted — pain reduced, life got busy, plan of care abandoned. The patient regresses, blames PT, doesn't refer their friend. Generic AI never reaches back out. The relationship and the outcome both die quietly.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a post-op ACL referral.",
      setup:
        "Wednesday, 4:18 PM. Caller is a new patient, ACL reconstruction 8 days ago, surgeon's office told him to call PT today to schedule his eval.",
      transcript: [
        { speaker: "Neverr", text: "Bayside Physical Therapy, this is the front desk line. How can I help?" },
        {
          speaker: "Caller",
          text: "Hi, I had ACL surgery last week with Dr. Reyes at Pacific Orthopedic. They told me to call you to start PT.",
        },
        {
          speaker: "Neverr",
          text: "Welcome — Dr. Reyes is one of our most active referring surgeons, we'll take great care of you. ACL post-op typically needs sports-PT specialty and we'll want to start your rehabilitation right on protocol. How many days post-op are you?",
        },
        { speaker: "Caller", text: "Eight days. They want me to start as soon as possible." },
        {
          speaker: "Neverr",
          text: "Right on protocol — most surgeons want PT initiated 7-10 days post-op. Quick intake questions to make sure we have everything for your insurance and to match you with the right PT. What's your insurance carrier?",
        },
        { speaker: "Caller", text: "Blue Cross PPO." },
        {
          speaker: "Neverr",
          text: "Blue Cross PPO is in-network with us — they typically allow 60 visits per year for post-op rehabilitation, and your co-pay is usually $40 per visit. We'll verify exact benefits and pre-auth before your first session. Do you have your referral paperwork from Dr. Reyes' office handy? I need the ICD-10 code and the visit recommendation.",
        },
        { speaker: "Caller", text: "Yeah, hold on... it says S83.511A and they recommended 3x/week for 12 weeks." },
        {
          speaker: "Neverr",
          text: "Perfect — S83.511A, sprain of ACL right knee, sequela code, standard for post-op. 3 times per week for 12 weeks aligns with the standard ACL rehab protocol. I'll book you with Sarah Park — she's our sports-medicine PT and works with most of Dr. Reyes' ACL post-ops. Can you do tomorrow at 2 PM for the initial evaluation? It's 60 minutes.",
        },
        { speaker: "Caller", text: "Yes, that works." },
        {
          speaker: "Neverr",
          text: "Booking tomorrow 2 PM with Sarah Park, NP eval, 60 minutes. I'll text you a secure link to our intake forms. Please bring your operative report from Dr. Reyes' office and wear shorts so Sarah can see your incision and assess range of motion. One last thing — are you currently using crutches or a brace?",
        },
        { speaker: "Caller", text: "Both. Locked brace, partial weight-bearing." },
        { speaker: "Neverr", text: "Got it, that'll be in the chart for Sarah. See you tomorrow at 2." },
      ],
      durationLabel: "Duration: 3:11",
      handoffMarkers: [
        "NEW PATIENT CHART CREATED in WebPT via Zapier — David Chen",
        "Source: Pacific Orthopedic / Dr. Reyes (post-op ACL referral)",
        "Diagnosis: S83.511A — sprain of ACL right knee, sequela",
        "Surgical procedure: ACL reconstruction, 8 days post-op",
        "Insurance: Blue Cross PPO (in-network, 60-visit/yr typical)",
        "Pre-auth: queued for Wed verification before Thu eval",
        "Appointment: Tomorrow 2:00 PM, Sarah Park (sports-med PT), 60 min",
        "Visit allotment captured: 3x/wk x 12 weeks = ~36 visits",
        "Mobility status: locked brace + crutches, partial weight-bearing",
        "Op report request: queued (faxed from Dr. Reyes' office to clinic)",
        "Intake forms: HIPAA-compliant SMS link sent",
      ],
      caption:
        "Three minutes, eleven seconds. Post-op ACL referral correctly routed to sports-medicine PT, ICD-10 code captured for billing, insurance pre-auth queued, visit allotment documented, op report requested from surgeon's office, mobility-status flagged for the PT, WebPT synced, intake forms sent. The patient starts protocol on time. Dr. Reyes sends his next ACL to your clinic too.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. We sign your BAA at signup.",
      },
      {
        step: "02",
        title: "Tell us about your clinic (~10 minutes)",
        body: "Pick 'Physical Therapy' — we pre-load the playbook. Add your PTs and PTAs (with specialties — sports, pelvic floor, vestibular, neuro, ortho, pediatric), your evaluation and treatment durations, your insurance carriers, your common referring physicians, your plan-of-care templates. Connect WebPT, Heno, Prompt EMR, Casamba, or JaneApp via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Referral-source triage. Specialty matching. Insurance pre-auth queued automatically. Plan-of-care progress tracked. Recall sequences run for drop-offs.",
      },
    ],
    whatItHandles: [
      "Referral-source triage — surgeon's office, primary care, self-referral, workers' comp, PI attorney",
      "Specialty matching — sports/ortho, pelvic floor, vestibular, neuro, pediatric, geriatric, post-op",
      "ICD-10 code capture from referral paperwork (CPT for billing follows)",
      "Insurance pre-auth queueing — captures all fields needed for verification before first visit",
      "Visit allotment tracking — knows the patient is at visit 4 of 12, books accordingly",
      "Plan-of-care progress recall — drop-offs at visit 4-6 get re-engagement sequences",
      "Workers' comp claim intake — employer, claim number, adjuster, return-to-work status",
      "PI attorney referral capture — same as chiropractic, with case-file workflow",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for clinical questions, complex insurance, complaints",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Booking the eval is the start. Plan-of-care completion and surgeon-referral relationships are where the platform compounds.",
      blocks: [
        {
          title: "Plan-of-care recall — bringing back the patients who quit at visit 6.",
          body: "Most PT clinics have hundreds of patients who completed 4-6 of 12 prescribed visits and drifted. Pain reduced, life got busy, the second half of rehab never happened. Neverr's SMS sequences automatically re-engage by plan-of-care stage ('David, you have 6 visits remaining on your ACL protocol — Sarah has Tuesday at 2 PM'), with replies routed back to your front desk. Patients who'd otherwise regress and blame PT come back and finish protocol.",
        },
        {
          title: "Surgeon referral relationship dashboard — track every source, every outcome.",
          body: "Surgeons send post-op referrals to PT clinics that complete protocol and report progress back. Neverr captures every referral by source surgeon, queues outcome reporting at protocol milestones, and surfaces a per-surgeon dashboard showing referrals received, completion rates, average outcomes. Your relationship with Dr. Reyes becomes a tracked partnership.",
        },
        {
          title: "Patient profiles that surface care plan context on every call.",
          body: "When a known patient calls, Neverr's caller profile flags them — current plan-of-care stage, insurance status, mobility constraints, last visit, any flagged notes. The AI doesn't make David re-explain his ACL protocol every time he calls to reschedule.",
        },
        {
          title: "Multi-location support for PT groups.",
          body: "For multi-clinic PT groups (2-15 locations is common in regional groups), Neverr handles centralized intake with location-specific routing. Each clinic has its own PT roster, its own surgeon relationships, its own insurance contracts — but the platform is one.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for physical therapy. HIPAA-compliant. Predictable pricing.",
      blocks: [
        {
          title: "Trained on physical therapy. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'PT' landing page. They don't know that ACL post-op needs sports-medicine specialty, that pelvic floor needs a private room, that vestibular requires specific PT training. Neverr is trained on PT intake — referral-source triage, specialty matching, plan-of-care progression, insurance pre-auth workflow.",
        },
        {
          title: "HIPAA, BAA, and audit logging. Standard, not add-on.",
          body: "You sign our BAA at signup. All call data encrypted in transit and at rest. Audit logging on every patient interaction.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "PT answering services punish busy seasons (back-to-school sports injuries, post-holiday weekend warrior cases, insurance deadline crunches). Neverr is flat-rate. Your bill in October looks like your bill in February.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the EMR your clinic already uses.",
      body: STANDARD_INTEGRATION_BODY("physical therapy EMR platforms"),
      examples: ["WebPT", "Heno", "Prompt EMR", "Casamba SMART", "JaneApp", "ClinicSource"],
    },
    close: {
      headline: "Stop letting plan-of-care drop-offs cost you outcomes and referrals.",
      subhead:
        "PT clinics using AI receptionists capture 80%+ of previously missed referrals, reduce plan-of-care drop-offs by 30%, and grow surgeon-referral relationships by tracking every outcome. Try Neverr free for 7 days — BAA signed at signup.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Physical Therapy Clinics — AI Receptionist with Pre-Auth Triage",
      description:
        "PT-trained AI receptionist with referral-source triage, specialty matching, insurance pre-auth queueing, and plan-of-care recall sequences. HIPAA + signed BAA. Integrates with WebPT, Heno, Prompt via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "electricians",
    name: "Electricians",
    category: "home-services",
    emoji: "⚡",
    featured: true,
    shortPitch:
      "Safety-critical emergency triage, commercial-vs-residential routing, panel/service-call differentiation.",
    hero: {
      headline: "Never miss another sparking-outlet emergency at 2 AM.",
      subhead:
        "Neverr is the AI receptionist trained for electrical contractors. It triages safety emergencies, respects your service area, knows your commercial-vs-residential routing, books panels and service calls into the right slot, and dispatches your on-call electrician with full context — sub-second answer, before your competitor's phone rings.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it triages a smoke-from-outlet call",
    },
    pain: [
      {
        title: "It can't recognize a safety emergency.",
        body: "Smoke from an outlet, a burning smell from the panel, sparking when an appliance is plugged in — these are immediate fire-risk emergencies. A flickering light is annoying but not urgent. Generic AI books everything as 'service call' and your team finds out at 7 AM that someone's house caught fire while waiting for Tuesday's appointment.",
      },
      {
        title: "It can't route commercial vs. residential.",
        body: "A commercial restaurant losing power on a Friday night is a $5,000 emergency dispatch with after-hours rates. A residential lighting issue is a Tuesday-morning service call. A new construction rough-in inspection failed and needs a re-inspection scheduled. Generic AI doesn't understand any of these contexts and books them all the same.",
      },
      {
        title: "It can't quote panel work intelligently.",
        body: "A 200-amp panel upgrade is a $3,000-$6,000 day-long job with a permit and inspection. A whole-home generator install is a $10,000-$20,000 multi-day project. EV charger installation has its own electrical math. Generic AI quotes 'service call starts at $99' and the customer is shocked when the actual quote arrives.",
      },
    ],
    proof: {
      title: "Watch Neverr triage a smoke-from-outlet emergency at 11:34 PM.",
      setup:
        "Saturday, 11:34 PM. Caller is a homeowner, smelled burning, smoke coming from a kitchen outlet.",
      transcript: [
        { speaker: "Neverr", text: "Lightning Electric, this is the after-hours line. What's going on?" },
        {
          speaker: "Caller",
          text: "Hi — I'm panicking a little. My kitchen outlet is smoking and I smell something burning. I unplugged everything but the outlet itself is still warm and there's like a brown mark above it.",
        },
        {
          speaker: "Neverr",
          text: "Okay — first, your safety is the priority. Do you know where your main electrical panel is, and can you turn off the breaker for that kitchen circuit right now? It's usually labeled 'kitchen' or 'small appliance.'",
        },
        { speaker: "Caller", text: "Yeah, panel's in the garage. Hold on... [pause] ...okay, I flipped the kitchen breaker." },
        { speaker: "Neverr", text: "Good. Is there still smoke coming from the outlet, or has it stopped?" },
        { speaker: "Caller", text: "It's stopped. Outlet's still warm but not smoking anymore." },
        {
          speaker: "Neverr",
          text: "Excellent — turning the breaker off cut the power. That outlet should not be used until our electrician sees it, and don't restore power to that circuit. This is a real electrical emergency — burned outlets and warm receptacles can be a fire risk. I'm dispatching our on-call electrician tonight. Where are you located?",
        },
        { speaker: "Caller", text: "412 Westbridge Drive, Bayside." },
        {
          speaker: "Neverr",
          text: "That's well within our service area. Our on-call tech is Marco — he's about 35 minutes out. After-hours emergency service fee is $189, plus the repair, which Marco will quote on-site once he sees the outlet. Most likely the outlet itself needs replacement and the wiring behind it inspected. Sound okay?",
        },
        { speaker: "Caller", text: "Yes, please. How quickly can he get here?" },
        {
          speaker: "Neverr",
          text: "I'm dispatching him now — 35-minute ETA. You'll get a text from him with his name, photo, and live tracking link. While you wait, please don't try to restore power to that circuit and keep an eye out for any smoke smell returning. If smoke comes back or you see flames, call 911 immediately.",
        },
        { speaker: "Caller", text: "Thank you. I really appreciate someone actually answering." },
        { speaker: "Neverr", text: "You bet. Marco will be there soon. Text this number back if anything changes before he arrives." },
      ],
      durationLabel: "Duration: 2:51",
      handoffMarkers: [
        "DISPATCHED — Marco Reyes, Truck 4, ETA 12:09 AM",
        "Synced to ServiceTitan as Job #8821 (EMERGENCY priority)",
        "Issue type: Burned outlet — fire risk, breaker shut off by homeowner",
        "Customer texted with tech name, photo, live tracking link",
        "After-hours service fee disclosed: $189",
        "Repair scope quoted on-site (outlet replacement + circuit inspection)",
        "Safety guidance delivered: don't restore power, watch for smoke",
        "911 fallback instructions delivered",
      ],
      caption:
        "Two minutes, fifty-one seconds. Real fire-risk emergency correctly classified, homeowner coached to safe state (breaker off), correct service area confirmed, on-call tech dispatched with full handoff, ServiceTitan synced as emergency priority, customer tracking link sent, 911 fallback explicit. Marco rolls up to a safe scene with full context.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your shop (~5 minutes)",
        body: "Pick 'Electrical' — we pre-load the playbook. Add your service area ZIPs, your trucks, your on-call rotation, your commercial-vs-residential split, your after-hours rate, your common job types (panel upgrades, generator installs, EV chargers, troubleshooting, new construction). Connect ServiceTitan, Housecall Pro, Jobber, FieldEdge, or Workiz via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number — or get a fresh one. Every call answered, triaged, dispatched, synced. After-hours emergencies texted to your on-call electrician in under 5 minutes.",
      },
    ],
    whatItHandles: [
      "Safety emergency triage — smoke, burning smell, sparking, hot outlets, partial power loss to part of a home",
      "Commercial vs. residential routing — different on-call rotations, different rates, different priorities",
      "Panel and service upgrade quoting (ranges, not firm) — 100A, 200A, 400A, sub-panel, generator transfer switch",
      "Whole-home generator inquiry intake — qualifies generator size needs, fuel type, transfer switch type",
      "EV charger installation — Level 2, panel capacity check, permit/inspection workflow",
      "New construction rough-in scheduling — coordinates with general contractor",
      "Re-inspection scheduling — knows the difference between failed inspection re-visit and new job",
      "Maintenance plan member recognition — applies member pricing, schedules included visits",
      "Service area filtering — automatic referrals or polite decline for jobs outside your area",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for complex commercial bids, complaints",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the call is the start. Maintenance memberships, commercial accounts, and recovery campaigns compound the platform's value.",
      blocks: [
        {
          title: "Maintenance plan recruitment and retention.",
          body: "Smart electricians are building recurring revenue with annual safety inspection memberships ($199-499/yr). Neverr captures every service call as a membership-conversation opportunity, runs renewal sequences automatically, and surfaces dormant members for proactive re-engagement.",
        },
        {
          title: "Commercial account relationship management.",
          body: "Restaurant, retail, and small office commercial accounts are recurring revenue if you keep them happy. Neverr captures every commercial call by account, queues service-history-aware responses, and surfaces a per-account dashboard so your commercial team knows which restaurants are calling more (red flag) and which are quiet (renewal target).",
        },
        {
          title: "Recovery campaigns for past customers who haven't called back.",
          body: "Most electrical shops have hundreds of past customers who hired you once and never called again — not because they were unhappy, but because their next electrical issue was 2 years away and they forgot your name. Neverr's recovery campaigns automatically re-engage with seasonal outreach ('Storm season is coming — we offer surge protection installation') and safety-tip messaging that keeps your name in mind.",
        },
        {
          title: "Multi-location support for electrical groups.",
          body: "For shops with 2-10 locations, Neverr handles centralized intake with location-specific routing. Each location has its own service area, its own on-call rotation, its own commercial accounts — but the platform is one.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for electrical. Sub-second response on safety. Predictable pricing.",
      blocks: [
        {
          title: "Trained on electrical. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with an 'electrician' landing page. They don't know that smoke from an outlet is an emergency vs. a flickering light is a Tuesday call, that a 200A panel upgrade is a multi-day permit job vs. a service call is 90 minutes. Neverr is trained on electrical triage, commercial-vs-residential routing, and panel/service work differentiation.",
        },
        {
          title: "Sub-second response when safety is on the line.",
          body: "A real fire-risk emergency at 11 PM doesn't wait for voicemail. Neverr answers in under a second, runs safety-aware triage, and dispatches before the situation worsens. That speed is the difference between a service call and a house fire.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "Generic answering services charge more during your busy seasons — heatwaves (AC overloads), winter storms (downed power), holiday lighting season. Neverr is flat-rate.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the FSM software your dispatcher already uses.",
      body: STANDARD_INTEGRATION_BODY("electrical-industry FSM tools"),
      examples: ["ServiceTitan", "Housecall Pro", "Jobber", "FieldEdge", "Service Fusion", "Workiz", "Successware"],
    },
    close: {
      headline: "Stop sending fire-risk emergencies to voicemail.",
      subhead:
        "Electricians using AI receptionists capture 30-50% more after-hours emergencies in their first month — and the safety triage prevents the cases that turn into liability claims. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Electricians — AI Receptionist for Emergency Dispatch",
      description:
        "Electrical-trained AI receptionist with safety-emergency triage, commercial/residential routing, panel-work quoting, and FSM integration via Zapier. Try free for 7 days.",
    },
  },

  {
    slug: "roofing-contractors",
    name: "Roofing Contractors",
    category: "home-services",
    emoji: "🏠",
    featured: true,
    shortPitch:
      "Storm-damage spike handling, insurance claim intake, repair-vs-replacement triage.",
    hero: {
      headline: "Never miss another insurance claim call after a hailstorm.",
      subhead:
        "Neverr is the AI receptionist trained for roofing contractors. It handles the call-volume spikes after storms, captures insurance claim intake correctly, triages repairs vs. replacements vs. inspections, and books inspections into your team's calendar — sub-second answer, even when 200 calls come in the same afternoon.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a post-storm insurance claim",
    },
    pain: [
      {
        title: "It can't handle storm-damage call volume.",
        body: "A single hailstorm can generate 200+ calls in 48 hours. Your office can't answer them all. Voicemail loses 85% of callers within the first try. Generic AI rolls everything to voicemail when overwhelmed. Your competitor with the AI receptionist captures the entire neighborhood; you get nothing.",
      },
      {
        title: "It can't capture insurance claim intake.",
        body: "A homeowner calling about hail damage needs you to capture: insurance carrier, claim number (if filed), adjuster name, deductible amount, prior roof age, prior claim history. Generic AI captures 'name and address.' Your sales team plays detective for 20 minutes per lead, conversion drops, you lose deals to the competitor who pre-qualified.",
      },
      {
        title: "It treats every roof call as the same call.",
        body: "A leak repair is a $400-$1,500 job and a same-day priority. A full replacement is a $15,000-$30,000 sales process with 2-3 visits. An annual inspection is a $200 maintenance call. A solar-attached roof leak has special handling. Generic AI books 'roof appointment' and your team scrambles.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a post-storm insurance claim call.",
      setup:
        "Tuesday, 3:47 PM. Hailstorm hit the area Sunday night. Caller is a homeowner — neighbor's roof is being replaced and the homeowner thinks her roof took damage too.",
      transcript: [
        { speaker: "Neverr", text: "Sunshine Roofing, this is the front desk line. How can I help?" },
        {
          speaker: "Caller",
          text: "Hi, my neighbor across the street is getting his whole roof replaced after the hailstorm Sunday night. I'm worried mine has damage too. Can someone come look at it?",
        },
        {
          speaker: "Neverr",
          text: "Absolutely — we've been busy this week with that exact situation. Hail can cause damage that's not visible from the ground. Our roof inspection is free for storm-damage assessment, and if there's damage we can document it for your insurance claim. Have you already filed a claim with your insurance company, or are you trying to figure out if you should?",
        },
        { speaker: "Caller", text: "I haven't filed anything yet. I wanted someone to look first to see if there's actually damage." },
        {
          speaker: "Neverr",
          text: "Smart approach — let's get an inspection on the books first. If our inspector finds damage, we'll document it with photos and a written report you can submit with your claim. That gives you a much stronger position than trying to file blind. What's your address?",
        },
        { speaker: "Caller", text: "412 Westbridge Drive, here in Bayside." },
        {
          speaker: "Neverr",
          text: "Got it. Bayside is right in the storm path — most of the roofs we've inspected this week have had at least some hail impact. Quick questions: how old is your current roof, and do you know what type — asphalt shingle, tile, metal?",
        },
        { speaker: "Caller", text: "Asphalt shingle. The roof is about 12 years old, original to the house when we moved in." },
        {
          speaker: "Neverr",
          text: "Got it — 12-year asphalt shingle roof. That's well within the typical lifespan, so insurance should consider it a legitimate claim if there's damage. Do you remember your insurance carrier?",
        },
        { speaker: "Caller", text: "State Farm." },
        {
          speaker: "Neverr",
          text: "Perfect, State Farm processes hail claims quickly when the damage is documented well. We have inspection slots tomorrow morning at 9 or 11, or Thursday at 1 PM. Inspections take about 45 minutes — the inspector goes up on the roof, takes photos, and writes you a report.",
        },
        { speaker: "Caller", text: "Tomorrow at 9 works." },
        {
          speaker: "Neverr",
          text: "Booking tomorrow 9 AM, free storm-damage inspection at 412 Westbridge. The inspector will be Marcus, he's our senior storm specialist. He'll text you when he's on his way. If he finds damage, he'll walk you through your insurance options — including helping you file the claim if you decide to. No pressure either way. Sound good?",
        },
        { speaker: "Caller", text: "Yes, thank you. I appreciate someone actually picking up — I tried two other companies and got voicemail." },
        { speaker: "Neverr", text: "We hear that all week. We'll see you tomorrow at 9." },
      ],
      durationLabel: "Duration: 3:42",
      handoffMarkers: [
        "NEW LEAD CREATED in AccuLynx via Zapier — Sarah Kim",
        "Source: Storm-damage inquiry (post-Sunday hailstorm)",
        "Address: 412 Westbridge Dr, Bayside (high-damage area)",
        "Roof: 12yr asphalt shingle (within insurance-claim-eligible age)",
        "Insurance carrier: State Farm (no claim filed yet)",
        "Inspection booked: Tomorrow 9:00 AM, Marcus (senior storm specialist)",
        "Job type: Free storm-damage inspection",
        "Estimated next step if damaged: insurance claim filing assistance",
        "Marcus notified with full context, ETA scheduled",
      ],
      caption:
        "Three minutes, forty-two seconds. Storm-damage lead captured before two competitors picked up. Insurance pre-qualification (carrier, no claim filed yet) makes the sales conversion path clear. Roof age and type captured for inspection prep. AccuLynx synced. Marcus rolls up to a homeowner who's already convinced you're the responsive one — because you actually answered.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your business (~5 minutes)",
        body: "Pick 'Roofing' — we pre-load the playbook. Add your service area, your inspectors and crews, your common roof types (asphalt, metal, tile, flat/TPO, slate), your insurance-claim workflow, your storm-response protocols, your repair-vs-replace pricing ranges. Connect AccuLynx, JobNimbus, Roofr, ServiceTitan, or Roofing CRM via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer, even during storm-spike volume. Inspections booked, insurance claim intake captured, leads synced.",
      },
    ],
    whatItHandles: [
      "Storm-damage call surges — handles 200+ calls in 48 hours without dropping",
      "Insurance claim intake — carrier, claim number (if filed), adjuster, deductible, prior claims",
      "Repair vs. replacement triage — leak (urgent), missing shingles (scheduled), full replacement (sales cycle)",
      "Annual inspection scheduling",
      "Solar-attached roof handling — captures solar contractor info for coordination",
      "Roof age and type capture for insurance-claim prep",
      "Commercial roofing intake — flat roof, TPO, EPDM, metal — different routing than residential",
      "New construction roofing — coordinates with general contractor",
      "Warranty claim intake for past installations",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for complex insurance disputes, commercial bids, complaints",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers, unsolicited \"I have a buyer for your business\" scams killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the storm-spike lead is the start. Insurance claim assistance, recovery campaigns, and warranty management compound the relationship.",
      blocks: [
        {
          title: "Storm-event response automation.",
          body: "When a major storm hits your service area, Neverr can run proactive outreach campaigns to past customers within the storm radius ('Storm passed through your area Sunday night — we're offering free inspections this week'). Past customers come back to the contractor they know, before the door-knockers from out-of-state show up.",
        },
        {
          title: "Insurance claim relationship dashboard.",
          body: "Track every claim by carrier, by adjuster, by outcome. Neverr captures full claim intake on every storm call and surfaces a dashboard showing your claim approval rates by carrier, claim cycle times, and which adjusters approve fast. Your sales team uses the data to set homeowner expectations correctly.",
        },
        {
          title: "Recovery campaigns for past customers and warranty members.",
          body: "Past customers from 5+ years ago are roof-replacement candidates again. Warranty members need annual inspections to keep coverage valid. Neverr's SMS sequences automatically re-engage by install date and warranty status. Past customers come back; warranty inspections get booked; replacement leads come from your existing base instead of cold ad spend.",
        },
        {
          title: "Commercial account relationship management.",
          body: "HOAs, property management companies, and commercial real estate accounts represent recurring inspection and repair revenue. Neverr captures every commercial call by account, queues service-history responses, and helps your commercial team manage 50-200 properties without dropping any.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for roofing. Storm-spike capable. Predictable pricing.",
      blocks: [
        {
          title: "Trained on roofing. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'roofing' landing page. They don't handle storm spikes (200+ calls in 48 hours), don't capture insurance claim intake correctly, don't differentiate repair from replacement from inspection. Neverr is trained on roofing intake patterns and storm-response workflows.",
        },
        {
          title: "Storm-spike capable. No call drops, no waitlists.",
          body: "When a hailstorm hits and your phone explodes, Neverr handles every concurrent call — sub-second answer on call 1 and call 200. Your competitor's voicemail loses 85% of callers; you get every lead in the storm path. That's the single biggest revenue swing in roofing.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "Generic answering services punish you exactly when you need them most — during storm-response weeks. Neverr is flat-rate. Your November bill (after a typical storm season) looks like your June bill.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the roofing CRM your team already uses.",
      body: STANDARD_INTEGRATION_BODY("roofing CRM platforms"),
      examples: ["AccuLynx", "JobNimbus", "Roofr", "ServiceTitan", "Housecall Pro", "Jobber", "FieldEdge"],
    },
    close: {
      headline: "Stop losing the storm-damage neighborhood to whoever picks up first.",
      subhead:
        "Roofing contractors using AI receptionists capture 80%+ of post-storm calls — versus the industry-standard 15% pickup rate during spike events. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Roofing Contractors — AI Receptionist with Storm-Spike Handling",
      description:
        "Roofing-trained AI receptionist with insurance-claim intake, storm-damage call surge handling, and CRM integration via Zapier (AccuLynx, JobNimbus, Roofr). Try free for 7 days.",
    },
  },
  // ==========================================================================
  // WAVE 2 BATCH 2 — Pet Care + Real Estate + Insurance + Auto (added 2026-05-05)
  // ==========================================================================
  {
    slug: "pet-boarding-grooming",
    name: "Pet Boarding & Grooming",
    category: "hospitality-lifestyle",
    emoji: "🐾",
    featured: true,
    shortPitch:
      "Vaccination verification, holiday-surge handling, breed-specific grooming intake, multi-service booking.",
    hero: {
      headline: "Never miss another holiday boarding inquiry at 9 PM.",
      subhead:
        "Neverr is the AI receptionist trained for pet boarding and grooming. It checks vaccination requirements, books boarding stays and grooming appointments by breed and service, captures temperament and dietary needs, and runs the holiday-surge call volume your front desk can't handle alone — sub-second answer, calendar-aware, no leashes dropped.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a Thanksgiving boarding inquiry",
    },
    pain: [
      {
        title: "It can't verify vaccination requirements.",
        body: "Boarding requires DHPP, rabies, and bordetella for dogs; FVRCP and rabies for cats — current within 12 months. Some facilities require kennel cough vaccine within the last 6 months. Generic AI books a boarding stay without checking, and your front desk discovers Friday afternoon that the dog can't be admitted because their vaccines are 14 months out — a stressed pet parent at 5 PM with no plan B.",
      },
      {
        title: "It can't match grooms to breeds and services.",
        body: "A Goldendoodle bath-and-tidy is 90 minutes. A Goldendoodle full groom with hand-scissoring is 3 hours. A Persian de-matting is 2-3 hours and may need sedation referral. A Shih Tzu puppy first-groom is 60 minutes and shouldn't be booked with a senior groomer who books all day. Generic AI books 'grooming appointment' and your groomer's day blows up.",
      },
      {
        title: "It loses your holiday revenue to inertia.",
        body: "Thanksgiving, Christmas, spring break, and 4th of July are when boarding facilities sell out 4-6 weeks in advance. Pet parents who can't reach you at 9 PM after hours book with PetSmart or the new boarding place down the street. Once they board there, they don't come back. The relationship moved.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a Thanksgiving boarding inquiry after hours.",
      setup:
        "Tuesday, October 7, 7:48 PM (about 6 weeks before Thanksgiving). Caller is an existing client booking boarding for the holiday week.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Pawsitively Pampered Pet Resort, this is Neverr — I work with the front desk team. Hi Jennifer, calling about Bailey?",
        },
        {
          speaker: "Caller",
          text: "Yes! I need to book her for Thanksgiving — we're going to my in-laws Wednesday through Sunday.",
        },
        {
          speaker: "Neverr",
          text: "Smart to book early — Thanksgiving week typically fills 4-5 weeks out and we're already 60% booked for that week. Let me get this on the calendar. So that's check-in Wednesday November 26 and check-out Sunday November 30 — four nights?",
        },
        { speaker: "Caller", text: "Yes, that's right." },
        {
          speaker: "Neverr",
          text: "Four nights of boarding for Bailey. Quick check on her file before I confirm — Bailey's last DHPP was March 12 of this year, so that's current. Rabies was March 12 last year, also current. Bordetella was June 5 of this year, current through December. All vaccinations are good for the Thanksgiving stay. One thing — we'll need her bordetella renewed before her next boarding stay after this one. Standard suite at $65/night, four nights is $260, plus we include two playgroup sessions per day at no extra charge. Will Bailey need any add-ons — exit bath ($45), nail trim ($18), or one-on-one playtime upgrades?",
        },
        {
          speaker: "Caller",
          text: "Yes, please add an exit bath so she's clean when I pick her up.",
        },
        {
          speaker: "Neverr",
          text: "Got it — exit bath added, $45. Total is $305. We require a 50% deposit at booking to hold holiday-week reservations, which is $152.50. I can text you a secure link to pay it right now and lock the reservation. Same dietary and medication notes as last time? Brand of food was Hill's Science Diet Sensitive Stomach, and she takes a daily joint supplement?",
        },
        { speaker: "Caller", text: "Yes exactly." },
        {
          speaker: "Neverr",
          text: "Perfect, all noted. Bringing your own food is included; we'll label and store it on check-in. The deposit link is going to your phone now. Once it's paid, you'll get a confirmation email with the reservation, our check-in window (Wednesday 8 AM–6 PM is best), and a packing checklist. Anything else I can help with?",
        },
        { speaker: "Caller", text: "Nope, that's perfect — thank you!" },
        {
          speaker: "Neverr",
          text: "Have a great trip, Jennifer. Bailey will have a blast — give her a treat from us when you tell her she's going to camp.",
        },
      ],
      durationLabel: "Duration: 3:22",
      handoffMarkers: [
        "BOARDING RESERVATION created in Gingr via Zapier",
        "Patient: Bailey, 3yo F/S Goldendoodle (existing client, full chart)",
        "Owner: Jennifer Martinez (recognized by phone, full file surfaced)",
        "Stay: Wed Nov 26 – Sun Nov 30, 4 nights, Standard Suite",
        "Vaccinations verified: DHPP ✓ Rabies ✓ Bordetella ✓ (all current)",
        "Bordetella renewal flag: due before next stay (June 5 + 12 months)",
        "Add-ons: Exit bath ($45)",
        "Total: $305 | Deposit required: $152.50 (50% holiday policy)",
        "Deposit link sent via secure SMS (Stripe-backed)",
        "Dietary: Hill's Science Diet Sensitive Stomach (own food)",
        "Medications: daily joint supplement",
        "Confirmation email queued: post-deposit-payment",
      ],
      caption:
        "Three minutes, twenty-two seconds. Existing client recognized by phone, vaccination compliance verified against the chart in real time, holiday-week deposit policy enforced, exit bath upsell captured, dietary and medication notes confirmed, secure payment link sent, Gingr synced. Jennifer locks her Thanksgiving plan from her couch at 7:48 PM. The reservation is paid before bedtime. Bailey's spot is held while three competitors are still on voicemail.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your facility (~10 minutes)",
        body: "Pick 'Pet Boarding' or 'Pet Grooming' (or both — most facilities run both). Add your services and pricing (suite types, daycare, grooming menu, add-ons), your vaccination requirements, your holiday calendar and surge policies, your groomers and their breed/service specialties, your kennel layout. Connect Gingr, PetExec, Kennel Connection, MoeGo, or ProPet via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Boarding and grooming intake. Vaccination check on every booking. Deposit collection during the call. Holiday-surge calls handled at scale.",
      },
    ],
    whatItHandles: [
      "Boarding reservation intake — suite type, dates, headcount (multi-pet households)",
      "Grooming appointment booking — breed-specific and service-specific time blocks",
      "Vaccination verification — DHPP, rabies, bordetella, FVRCP, kennel cough on call",
      "Add-on capture — exit baths, nail trims, teeth brushing, one-on-one playtime, medication administration",
      "Daycare booking — full-day vs. half-day, recurring weekly slots",
      "Holiday surge management — auto-applies holiday deposit policies, multi-night minimums",
      "Multi-pet household routing — recognizes families with 2-4 pets, books accordingly",
      "Existing client recognition — phone-number lookup surfaces full pet profile",
      "Dietary, medication, temperament, behavior notes captured",
      "Special needs handling — senior pets, anxious pets, reactive dogs need different protocols",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for behavior complaints, medical emergencies, complex situations",
      "Spam filtering — extended-warranty, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Booking the stay is the start. Vaccination compliance, holiday revenue, and retention compound the platform's value.",
      blocks: [
        {
          title: "Vaccination renewal sequences keep your boarders compliant.",
          body: "Most facilities have hundreds of pets whose vaccinations expire between visits — the bordetella that lapses in October before Thanksgiving boarding is the #1 reason a boarding stay gets refused at check-in. Neverr's SMS sequences automatically remind owners 30 days before any vaccination expiration ('Bailey's bordetella expires December 5 — get it updated before her next boarding stay'). Compliance stays current; refusals at check-in disappear.",
        },
        {
          title: "Holiday-week pre-bookings — captured 6 weeks early.",
          body: "Thanksgiving, Christmas, spring break, 4th of July, Memorial Day — these weeks sell out 4-6 weeks in advance. Neverr can run proactive outreach campaigns to past holiday boarders ('Thanksgiving is 6 weeks out — Bailey's spot from last year is available if you want to lock it in now'). Past boarders re-book before they think to shop around.",
        },
        {
          title: "Patient profiles that surface temperament, diet, meds on every call.",
          body: "The dog with food allergies. The anxious cat who needs the quiet kennel. The senior who needs medication twice a day. The brother-and-sister who must be boarded together. Neverr surfaces all of it on call connect — caller introduces themselves, AI greets them by pet name, and the booking conversation skips the re-introduction every time.",
        },
        {
          title: "Multi-location support for boarding and grooming groups.",
          body: "For groups with 2-10 facilities (common in regional pet care groups), Neverr handles centralized intake with location-specific routing. Each facility has its own kennel layout, its own holiday rates, its own groomers — but the platform is one. Pet parents who move across locations stay with your group.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for pet care. Holiday-surge ready. Predictable pricing.",
      blocks: [
        {
          title: "Trained on pet care. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'pet boarding' landing page. They don't know that a Goldendoodle full groom is 3 hours, that bordetella expires in 12 months, that holiday weeks need deposit policies, that anxious pets need the quiet kennel. Neverr is trained specifically on pet care intake — vaccination compliance, breed-specific grooming, multi-pet households, holiday surges.",
        },
        {
          title: "Holiday-surge capable. Sub-second answer at peak demand.",
          body: "The week before Thanksgiving generates 5x normal call volume. Generic answering services drop calls or roll to voicemail; you lose the new clients who would have boarded with you for years. Neverr handles every concurrent call at sub-second answer, even when 50 people are dialing in the same hour.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "Generic answering services charge more during holiday surge weeks — the exact moment you can least afford it. Neverr is flat-rate. Your bill in November (Thanksgiving prep) looks like your bill in February.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the boarding/grooming software your team already uses.",
      body: STANDARD_INTEGRATION_BODY("pet care platforms"),
      examples: ["Gingr", "PetExec", "Kennel Connection", "ProPet", "MoeGo", "PawLoyalty", "Time To Pet"],
    },
    close: {
      headline: "Stop losing your holiday boarders to PetSmart and voicemail.",
      subhead:
        "Pet boarding and grooming facilities using AI receptionists capture 80%+ of after-hours holiday inquiries — at $200-$500 per holiday week per pet, that's tens of thousands in recovered revenue per location. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Pet Boarding & Grooming — AI Receptionist with Vaccination Verification",
      description:
        "Pet care-trained AI receptionist with boarding and grooming intake, vaccination verification, holiday-surge handling, and PIMS integration via Zapier (Gingr, PetExec, Kennel Connection, MoeGo). Try free for 7 days.",
    },
  },
  {
    slug: "property-management",
    name: "Property Management",
    category: "professional-services",
    emoji: "🏘️",
    featured: true,
    shortPitch:
      "Tenant request triage, owner communication, prospect lead capture, multi-property routing.",
    hero: {
      headline: "Never miss another maintenance emergency from a panicked tenant.",
      subhead:
        "Neverr is the AI receptionist trained for property management. It triages tenant maintenance requests by urgency, routes prospect inquiries to leasing, escalates emergencies to your on-call team, captures owner communications correctly, and handles every property in your portfolio with location-specific awareness — sub-second answer, 24/7, no missed midnight floods.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a 2 AM water leak",
    },
    pain: [
      {
        title: "It can't tell a maintenance emergency from a routine request.",
        body: "A water leak in unit 3B at 2 AM is an emergency that needs a plumber dispatched now to prevent ceiling damage in 3A below. A burned-out lightbulb is a Tuesday-morning maintenance ticket. A non-functioning HVAC in July is an urgent same-day. Generic AI books all of them as 'maintenance request' and your team finds out at 9 AM that 3A's ceiling collapsed.",
      },
      {
        title: "It can't route by stakeholder type.",
        body: "Tenants, owners, prospects, vendors, contractors — each calls about different things and each needs different routing. A prospect asking about availability is leasing-team work. An owner asking about reserves is bookkeeping-team work. A tenant calling about a leak is maintenance. Generic AI mixes them all into 'messages for the office' and your team plays detective.",
      },
      {
        title: "It loses your prospect leads to inertia.",
        body: "Apartment leasing is a speed-to-lead vertical — the prospect calling about a unit at 7 PM Thursday is also calling 4 other complexes that night. The first to answer with availability and a tour booking wins the lease. Generic AI takes a message; your competitor's leasing agent picks up the phone. The unit fills with their tenant, not yours.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a 2 AM emergency water leak.",
      setup:
        "Wednesday, 2:14 AM. Caller is a tenant in a managed apartment complex. Water dripping from kitchen ceiling.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Bay Vista Property Management, after-hours line. This is Neverr — I work with the team. How can I help?",
        },
        {
          speaker: "Caller",
          text: "Hi, I'm a tenant in 3B and there's water dripping through my kitchen ceiling. It started about 20 minutes ago and it's getting worse.",
        },
        {
          speaker: "Neverr",
          text: "Marcus — this is an emergency, I'm escalating immediately. A few quick questions while I get our on-call maintenance coordinator on the line. Where exactly is the water coming from? Is it dripping in one spot or a wider area, and is it clear water or discolored?",
        },
        {
          speaker: "Caller",
          text: "It started in one spot, now it's spreading — there are two spots dripping now. The water is mostly clear but it's starting to look brownish.",
        },
        {
          speaker: "Neverr",
          text: "Got it — that suggests it's coming from the unit above, 4B, likely a plumbing leak. The brown is from the ceiling material starting to soak through. Have you been able to knock on 4B?",
        },
        {
          speaker: "Caller",
          text: "No, I didn't want to wake them up.",
        },
        {
          speaker: "Neverr",
          text: "This is the right time to wake them up — there's a real chance they have a running toilet, a burst pipe, or a dishwasher leak they don't know about. Please knock now or call them through the building intercom. While you do that, I'm dispatching our on-call maintenance team — 25-minute ETA. Do you have buckets or towels to catch the dripping water and protect your stuff?",
        },
        { speaker: "Caller", text: "Yeah, I'm grabbing buckets now." },
        {
          speaker: "Neverr",
          text: "Good. Move anything valuable away from the drip zone if you can. Once you wake up 4B, ask them to check their kitchen, bathroom, and laundry — if they find a leak, they should shut off the water valve under the sink or behind the toilet. If they can't find it or it's continuing, tell them we're sending maintenance who can shut off water to the line. Marco — our on-call maintenance lead — has been notified with the situation. He'll text you when he's en route. The property owner of 4B will be notified about the leak source as part of the incident report. Is there anything else immediately urgent?",
        },
        {
          speaker: "Caller",
          text: "No, I think that covers it. Thanks for the help.",
        },
        {
          speaker: "Neverr",
          text: "You bet. Marco will be there in about 25 minutes. Text this number back if anything changes before he arrives — and again, please knock on 4B as soon as we hang up.",
        },
      ],
      durationLabel: "Duration: 3:11",
      handoffMarkers: [
        "EMERGENCY MAINTENANCE TICKET created in AppFolio via Zapier",
        "Property: 412 Bay Vista Apartments, Unit 3B",
        "Tenant: Marcus Reyes (lease verified, full file surfaced)",
        "Issue: Water leak from ceiling (likely from Unit 4B above)",
        "Severity: EMERGENCY — active water damage in progress",
        "Suspected source: Unit 4B (plumbing leak — toilet/sink/dishwasher)",
        "Marco Reyes (on-call maintenance) dispatched, ETA 2:39 AM",
        "Tenant coached: contact 4B, set up buckets, move valuables",
        "Unit 4B owner: notification queued (post-resolution incident report)",
        "Damage documentation queued: photos requested from Marco on arrival",
        "Tracking: text update at 2:39 AM ETA + photos",
      ],
      caption:
        "Three minutes, eleven seconds. 2:14 AM emergency triaged correctly — water source diagnosed, tenant coached on immediate actions, on-call maintenance dispatched with full context, AppFolio synced as emergency priority, Unit 4B owner queued for incident report. Marco arrives at a tenant who isn't alone, ceilings 2 floors down get protected, the property manager wakes up to a resolved situation instead of a flooded apartment.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your portfolio (~10 minutes)",
        body: "Pick 'Property Management.' Add your properties (single-family, multifamily, commercial), your maintenance team and on-call rotation, your owner roster, your leasing protocols, your emergency vs. routine categorization, your vendor and contractor list. Connect AppFolio, Buildium, Yardi Breeze, RentRedi, or TenantCloud via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Tenant maintenance triage. Prospect lead capture. Owner inquiry routing. Emergency dispatch with full handoff. Multi-property awareness on every call.",
      },
    ],
    whatItHandles: [
      "Maintenance emergency triage — water leaks, no heat (winter), no AC (summer), gas smell, electrical issues, lockouts",
      "Routine maintenance request intake — categorized by trade, prioritized, ticketed",
      "Prospect lead capture — availability, qualifying questions, tour booking",
      "Owner inquiry routing — reserves, distributions, P&L questions, vendor approvals",
      "Vendor/contractor coordination — work order intake, scheduling",
      "Multi-property routing — tenant calls recognized by property and unit",
      "Lease renewal inquiries — captures intent, queues for leasing team",
      "Move-out coordination — security deposit questions, walk-through scheduling",
      "Pet policy and amenity questions",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for legal escalations, owner urgent issues, eviction-track conversations",
      "Spam filtering — wholesaler 'we want to buy your properties' calls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the call is the start. Tenant retention, owner relationships, and prospect conversion compound the platform's value.",
      blocks: [
        {
          title: "Tenant communication that scales without losing personalization.",
          body: "Most property managers struggle to maintain individual relationships once they hit 200+ units. Neverr's caller profile surfaces full tenant context — lease end date, payment history, prior maintenance issues, communication preferences. Every call feels like a small-property-manager call even when you're managing 2,000 units.",
        },
        {
          title: "Prospect lead recovery — bringing back the ones who didn't lease.",
          body: "Most property managers have hundreds of past prospects who toured a unit and didn't sign — different timing, different priorities, just kept looking. Neverr's SMS sequences automatically re-engage with personalized outreach when relevant units come available ('Hi Sarah, the 1BR you toured at Bay Vista has a similar unit opening November 15'). Past prospects come back when their timing is right.",
        },
        {
          title: "Owner reporting and communication that actually happens.",
          body: "Owners want updates on their property — vacancy, maintenance issues, lease renewals, market conditions. Most property managers run owner reports quarterly because monthly is too much manual work. Neverr can capture every owner call, surface a per-owner communication log, and queue automated updates so owners feel informed without your team doing manual newsletter work.",
        },
        {
          title: "Multi-property analytics — by property, by issue type, by tenant.",
          body: "Which property is generating the most maintenance calls? Which type of issue is most common at which complex? Which tenants are at-risk for non-renewal based on call frequency and tone? Neverr's analytics dashboard breaks all of it down. Your team manages the portfolio with data, not just inbox triage.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for property management. Emergency-grade response. Predictable pricing.",
      blocks: [
        {
          title: "Trained on property management. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'property management' landing page. They can't tell a 2 AM water leak from a Tuesday lightbulb, can't route prospect-vs-tenant-vs-owner-vs-vendor, don't know multi-property context. Neverr is trained on property management workflows — emergency triage, stakeholder routing, multi-property awareness.",
        },
        {
          title: "Sub-second emergency response. 2 AM doesn't wait for voicemail.",
          body: "A water leak at 2 AM that goes to voicemail until 8 AM is the difference between a $300 plumber visit and a $30,000 ceiling rebuild. Neverr answers in under a second, runs emergency triage, dispatches your on-call team. That speed is the single biggest cost-avoidance lever in property management.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "Generic answering services punish busy seasons — winter heat outages, summer AC failures, leasing-season prospect spikes. Neverr is flat-rate. Your bill in July (AC season) looks like your bill in October.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the property management software your team already uses.",
      body: STANDARD_INTEGRATION_BODY("property management platforms"),
      examples: ["AppFolio", "Buildium", "Yardi Breeze", "RentRedi", "TenantCloud", "Rentec Direct", "Propertyware"],
    },
    close: {
      headline: "Stop letting 2 AM emergencies turn into $30,000 ceiling rebuilds.",
      subhead:
        "Property management companies using AI receptionists capture 100% of emergency calls, reduce maintenance response times to under 30 minutes, and convert 30%+ more prospect inquiries into tours. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Property Management — AI Receptionist with Emergency Triage",
      description:
        "Property management-trained AI receptionist with maintenance emergency triage, multi-property routing, and software integration via Zapier (AppFolio, Buildium, Yardi Breeze, RentRedi). Try free for 7 days.",
    },
  },
  {
    slug: "insurance-agents",
    name: "Insurance Agents",
    category: "professional-services",
    emoji: "🛡️",
    featured: true,
    shortPitch:
      "Speed-to-lead, line-of-business qualification, quote intake, captive-vs-independent positioning, claims triage.",
    hero: {
      headline: "Be the first agent who picks up. Win the 7-year customer.",
      subhead:
        "Neverr is the AI receptionist trained for independent insurance agents. It answers in under a second, qualifies by line of business (auto, home, life, commercial, umbrella), captures the data you need to quote, books appointments, and triages claims to your team — sub-second answer, before the captive agency next door even rings.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles an after-hours auto quote inquiry",
    },
    pain: [
      {
        title: "It can't qualify by line of business.",
        body: "An auto inquiry needs vehicle info, current carrier, driving history, household drivers. A homeowners inquiry needs property info, claims history, current carrier, mortgage. A life inquiry needs age, health, term-vs-whole, beneficiary structure. A commercial inquiry needs business type, payroll, prior claims. Generic AI captures 'name and number.' Your team plays detective for 20 minutes per lead, conversion drops, deals get lost to the agent who pre-qualified.",
      },
      {
        title: "It can't compete on speed-to-lead.",
        body: "Insurance is the most extreme speed-to-lead vertical that exists. Responding within 5 minutes vs. 30 minutes increases your conversion 21x. The captive agency call centers (State Farm, Allstate, GEICO, Progressive) operate 24/7 with sub-30-second answer. Independent agents who roll to voicemail at 6 PM lose the prospect to a captive who picked up. The 60-80% of policies that close more than 60 days after first inquiry — the first conversation determines who wins.",
      },
      {
        title: "It loses the 7-year customer.",
        body: "Insurance customer LTV runs 7 years on average — auto + home + life + umbrella, multiple policies per household, multi-policy discounts, referrals to family. The first call is worth $1,500 in immediate commission and $10,500+ over the customer's lifetime. Generic AI captures voicemail; your competitor builds a 7-year relationship.",
      },
    ],
    proof: {
      title: "Watch Neverr handle an after-hours auto quote inquiry.",
      setup:
        "Tuesday, 6:47 PM. Office closed at 5:30 PM. Caller is a new prospect, just got a renewal letter from her current carrier with a $400 premium increase, googling for alternatives.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Bayshore Insurance Agency, this is Neverr — I work with the agency. Thanks for calling tonight, how can I help?",
        },
        {
          speaker: "Caller",
          text: "Hi, my auto insurance just went up 400 dollars on renewal and I'm trying to get a few quotes to compare. Are you guys able to quote me?",
        },
        {
          speaker: "Neverr",
          text: "Absolutely — that's exactly the kind of situation we help with most often. As an independent agency, we work with 12 carriers, so we can compare rates across all of them and find you the best fit. Mind if I get a few details to put together a real quote?",
        },
        { speaker: "Caller", text: "Sure, go ahead." },
        {
          speaker: "Neverr",
          text: "First, what's your current carrier and what's your renewal premium they just quoted you?",
        },
        {
          speaker: "Caller",
          text: "I'm with Geico right now, paying $1,440 every six months. The renewal letter said $1,840.",
        },
        {
          speaker: "Neverr",
          text: "$400 increase on renewal — pretty common right now, carriers are repricing aggressively. Quick check on a few things that affect your rate. How many vehicles on the policy?",
        },
        {
          speaker: "Caller",
          text: "Two — a 2022 Honda Accord and a 2018 Ford F-150.",
        },
        {
          speaker: "Neverr",
          text: "And drivers — just you, or you and a spouse, or any teenagers?",
        },
        {
          speaker: "Caller",
          text: "Me and my husband. Just the two of us, no kids on the policy.",
        },
        {
          speaker: "Neverr",
          text: "Got it. Have either of you had any accidents, tickets, or claims in the last 5 years?",
        },
        {
          speaker: "Caller",
          text: "I had one minor fender-bender claim about 3 years ago — no injuries, the other driver's fault. My husband's clean.",
        },
        {
          speaker: "Neverr",
          text: "Not-at-fault claim from 3 years ago, that's actually fine — shouldn't significantly impact your rate. What kind of coverage are you carrying right now? State minimum, or full coverage with comprehensive and collision?",
        },
        {
          speaker: "Caller",
          text: "Full coverage. The Accord is still being financed and the F-150 we own outright but we kept full coverage on both.",
        },
        {
          speaker: "Neverr",
          text: "Good — most of our quotes will assume full coverage to match what you have. What's your zip code, and your last name and birth year for both you and your husband — just for the carrier rate quotes?",
        },
        {
          speaker: "Caller",
          text: "Zip is 94102. Last name Chen. I'm 1985, my husband is 1983.",
        },
        {
          speaker: "Neverr",
          text: "Perfect. I have everything I need to run quotes. Here's what's going to happen — Marcus, our senior auto specialist, will pull rates from our 12 carriers tomorrow morning and call you between 9 and 10 AM with a comparison. He'll also check whether bundling with home insurance would save you additional money — do you currently have homeowners or renters?",
        },
        {
          speaker: "Caller",
          text: "Homeowners, also through Geico. If we could save by bundling that would be great too.",
        },
        {
          speaker: "Neverr",
          text: "Excellent — Marcus will pull homeowners quotes too. Most of our clients save 12-18% by bundling auto and home with the same carrier. He'll text you tonight with a confirmation that he's got your file, and he'll have all the quotes ready when he calls in the morning. What's your email so I can send the confirmation?",
        },
        { speaker: "Caller", text: "sarah.chen@email.com" },
        {
          speaker: "Neverr",
          text: "Got it, Sarah. Marcus will text you within an hour and call tomorrow at 9 AM with quotes from all 12 carriers across auto and home. Thanks for thinking of us — we'll do everything we can to beat that $400 increase.",
        },
      ],
      durationLabel: "Duration: 4:14",
      handoffMarkers: [
        "NEW PROSPECT created in EZLynx via Zapier — Sarah Chen",
        "Source: Google Local Service Ad, 'auto insurance Bayside'",
        "LOB requested: AUTO + HOME (bundle opportunity flagged)",
        "Current carrier: Geico (auto $1,440/6mo, $1,840 renewal — 28% increase)",
        "Vehicles: 2022 Honda Accord, 2018 Ford F-150 (full coverage on both)",
        "Drivers: Sarah Chen (b.1985), spouse (b.1983), zip 94102",
        "Claims/violations: 1 not-at-fault claim, 3 years old (de-minimis)",
        "Bundle target: Homeowners (currently Geico)",
        "Assigned: Marcus (senior auto specialist)",
        "Confirmation text queued: T+1hr",
        "Quote-callback queued: Wed 9-10 AM",
        "Quote prep queued: 12 carriers, auto + home bundled",
      ],
      caption:
        "Four minutes, fourteen seconds. After-hours quote inquiry from a Geico customer facing a $400 renewal increase, captured the moment her intent peaked. Auto qualification complete (vehicles, drivers, history, current premium, coverage type). Home bundle opportunity flagged. Marcus opens his Wednesday morning with the most prepared quote callback he's run all month — the prospect has been waiting 14 hours for a real conversation, and Bayshore is the agency that gave it to her first. The captive on the corner is still on voicemail.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your agency (~10 minutes)",
        body: "Pick 'Insurance.' Add your carriers (the 8-15 you appoint), your lines of business (auto, home, life, commercial, umbrella, specialty), your CSR/agent roster and specialties, your appointment scheduling rules, your quote callback workflow, your claims-triage protocol. Connect Applied Epic, Vertafore AMS360, EZLynx, HawkSoft, or NowCerts via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Line-of-business qualification. Full intake on every prospect. Claims triaged to the right CSR. Existing clients recognized and routed.",
      },
    ],
    whatItHandles: [
      "Auto quote intake — vehicles, drivers, current carrier and premium, claims/violations, coverage level, bundle opportunity",
      "Home quote intake — property type, year built, square footage, current carrier, claims, mortgage holder",
      "Life quote intake — age, health, term-vs-whole interest, coverage amount, beneficiary structure",
      "Commercial quote intake — business type, payroll, vehicles, prior claims, coverage needs",
      "Umbrella and specialty (boat, RV, motorcycle, valuables) intake",
      "Claims triage — captures incident type, urgency, injuries, location, routes to claims CSR",
      "Existing client recognition — phone-number lookup surfaces policy file, applies VIP routing",
      "Renewal review scheduling",
      "Endorsement requests (add a vehicle, add a driver, change address)",
      "Certificate of insurance requests for commercial clients",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for negotiations, complex commercial bids, complaints",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the call is the start. Speed-to-lead conversion, retention, and cross-sell compound the platform's value.",
      blocks: [
        {
          title: "Speed-to-lead automation that actually wins.",
          body: "Insurance is a sub-5-minute response game. Neverr captures the call, runs full qualification, and texts your assigned producer within 60 seconds — full lead profile, suggested talking points, ready-to-quote intake. Your producer dials a warm prospect with everything pre-captured, while the captive next door is still routing through their phone tree.",
        },
        {
          title: "Renewal review and cross-sell sequences.",
          body: "Multi-policy households are 4x more likely to renew and 2x more profitable. Neverr's SMS sequences proactively schedule annual renewal reviews and surface cross-sell opportunities ('Sarah, your auto renewal is in 30 days — want to schedule a quick call with Marcus to compare rates and discuss adding life insurance?'). Renewal reviews stop being missed; cross-sell happens systematically.",
        },
        {
          title: "Caller profiles that surface policy context on every call.",
          body: "The client who has 3 vehicles, a homeowners policy, an umbrella, and a 19-year-old daughter who's about to be added to the auto policy. The commercial client who has 8 employees and renewed last month. Neverr surfaces all of it on call connect — the client doesn't re-explain their household every time they call to ask a billing question.",
        },
        {
          title: "Aged-lead recovery campaigns.",
          body: "Most agencies have hundreds of leads who quoted 60+ days ago and didn't bind. Industry conversion on aged leads is 1-4% if anyone calls them. Neverr can run automated re-engagement sequences ('Sarah, you got a quote 90 days ago — your current renewal is coming up, want to revisit?'). Aged leads convert at 2-3x with consistent follow-up; Neverr makes that follow-up automatic.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for insurance. Captive-grade speed. Predictable pricing.",
      blocks: [
        {
          title: "Trained on insurance. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with an 'insurance' landing page. They don't know that auto needs different qualification than home, that a not-at-fault claim from 3 years ago is de-minimis, that bundling auto and home saves 12-18%, that speed-to-lead is the single biggest conversion lever. Neverr is trained on insurance intake — line-of-business qualification, carrier-aware quoting, claims triage, retention sequences.",
        },
        {
          title: "Sub-second response. The captive agencies operate 24/7. So do you now.",
          body: "Independent agents lose to captive agencies because the captives have call centers. Neverr levels the playing field. Sub-second answer, full qualification, callback queued for your producer with a fully captured lead. The independent advantage (more carriers, better rates, real relationship) wins when you're actually first to answer.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute, no per-lead.",
          body: "Generic answering services and lead-gen platforms punish you per-conversation — exactly the thing we want to maximize. Neverr is flat-rate. Your bill in renewal-spike months looks like your bill in February.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the agency management system your team already uses.",
      body: STANDARD_INTEGRATION_BODY("insurance AMS platforms"),
      examples: ["Applied Epic", "Vertafore AMS360", "EZLynx", "HawkSoft", "NowCerts", "Agency Matrix", "QQCatalyst"],
    },
    close: {
      headline: "Stop losing 7-year customers to whoever picks up first.",
      subhead:
        "Insurance agencies using AI receptionists increase lead capture by 23-47% and capture the after-hours quote requests that captive agencies otherwise win by default. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Insurance Agents — AI Receptionist with Speed-to-Lead Qualification",
      description:
        "Insurance-trained AI receptionist with line-of-business qualification (auto, home, life, commercial), claims triage, and AMS integration via Zapier (Applied Epic, Vertafore AMS360, EZLynx, HawkSoft). Try free for 7 days.",
    },
  },
  {
    slug: "car-dealerships",
    name: "Car Dealerships",
    category: "auto-transport",
    emoji: "🚗",
    featured: true,
    shortPitch:
      "Sales and service split, after-hours capture, BDC augmentation, inventory-aware qualification, multi-rooftop routing.",
    hero: {
      headline: "Stop losing $1M+ a year to voicemail at 7 PM.",
      subhead:
        "Neverr is the AI receptionist trained for car dealerships — sales and service. It answers every call in under a second, qualifies inventory inquiries, books service appointments, captures the 56% of leads that come in after hours, and integrates with your DMS, CRM, and BDC — augmenting your team during the day, covering them when they're closed.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles an after-hours sales inquiry",
    },
    pain: [
      {
        title: "It can't separate sales from service.",
        body: "A sales call is 'is this 2024 Camry still available, what's the OTD price, can I schedule a test drive?' — different qualification, different routing, different urgency than a service call ('my check engine light is on, when can you get me in?'). Generic AI books 'appointment' and your sales BDC team plays detective in the morning while the service department gets buried in misrouted tickets.",
      },
      {
        title: "It can't capture the 56% of leads who call after hours.",
        body: "McKinsey research shows 56% of dealership leads come in outside business hours, and 70% of voicemail callers call a competitor within 30 minutes. The average dealer response time on after-hours leads is 42 hours. Top BDCs respond in under 5 minutes — and convert at 80% vs. the 50% industry average. The difference is whether someone (or something) actually picks up the phone at 7:43 PM.",
      },
      {
        title: "It loses $1M+ per store per year.",
        body: "Industry research consistently shows that average dealerships lose over $1 million per store annually from missed calls — split roughly between $853K in service revenue (missed appointments) and $200K+ in sales (lost showroom traffic). 31.8% of customers hang up while on hold, 32.3% leave voicemails that go unreturned, 60% won't wait more than a minute on hold. Generic AI doesn't fix any of this. Neverr was built specifically for it.",
      },
    ],
    proof: {
      title: "Watch Neverr handle an after-hours sales inquiry from a competitor's website.",
      setup:
        "Thursday, 7:43 PM. Showroom closed at 7. Caller is a buyer who saw the dealer's used 2022 Toyota Tacoma listed online while researching from a competitor's website.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Pacific Toyota, this is the after-hours sales line. I'm Neverr, working with the sales team. How can I help tonight?",
        },
        {
          speaker: "Caller",
          text: "Yeah, hi. I'm looking at a 2022 Tacoma TRD Off-Road on your website — VIN ending 4421. Is that one still available?",
        },
        {
          speaker: "Neverr",
          text: "Let me check — 2022 Tacoma TRD Off-Road, VIN 4421. Yes, that one is still in inventory and on the lot. Black exterior, 34,200 miles, single owner, certified pre-owned. Listed at $34,995. Are you looking at this for yourself, and is this a purchase or a trade-in situation?",
        },
        {
          speaker: "Caller",
          text: "For myself. I have a 2018 Tacoma I'm thinking about trading in.",
        },
        {
          speaker: "Neverr",
          text: "Smart move — Tacoma trades retain value really well. The 2022 TRD Off-Road is a meaningful upgrade — newer infotainment, better suspension package, higher trim. Quick questions so we can have your trade evaluated when you come in. What's the year, trim, and mileage on your 2018?",
        },
        {
          speaker: "Caller",
          text: "2018 Tacoma SR5, V6, about 78,000 miles. It's in good shape, no accidents.",
        },
        {
          speaker: "Neverr",
          text: "SR5 V6 with 78K, clean history. We can get you a real trade number when you're here — that gets done by our used-car appraiser. To set expectations, current market for a 2018 SR5 V6 78K runs $22,000-$26,000 depending on condition, options, and tires. We'd need to see it in person. For the new vehicle, are you looking to finance, lease, or pay cash?",
        },
        {
          speaker: "Caller",
          text: "Finance. I'd want to see what payment options are.",
        },
        {
          speaker: "Neverr",
          text: "Got it. The TRD Off-Road at $34,995, with your trade applied, you'd be financing somewhere in the $11,000-$13,000 range depending on the appraisal — that's a very manageable payment for most buyers. Our finance team will run actual numbers when you're here. Best way to move this forward — let's get you in for a test drive and trade evaluation. We have Saturday morning at 10, Saturday at 1, or Sunday at noon available. Which works best?",
        },
        { speaker: "Caller", text: "Saturday 10 works." },
        {
          speaker: "Neverr",
          text: "Booking Saturday 10 AM with Tony — he's our pre-owned specialist and works with most of our Tacoma buyers. Plan on about 90 minutes — test drive, trade appraisal, and time with our finance team to look at numbers. Bring your title and registration for the 2018, your driver's license, and proof of insurance for the test drive. Can I get your full name and the best mobile number for Tony to text you tomorrow?",
        },
        {
          speaker: "Caller",
          text: "Marcus Reyes, this is the best number — 415-555-0838.",
        },
        {
          speaker: "Neverr",
          text: "Got it, Marcus. You'll get a text from Tony tomorrow morning confirming the appointment with directions and a link to pre-fill your credit application if you want to save time on Saturday. Anything else I can help with tonight?",
        },
        {
          speaker: "Caller",
          text: "No, that's perfect. Thanks for actually picking up — three other dealers I called tonight all rolled to voicemail.",
        },
        {
          speaker: "Neverr",
          text: "Hear that all the time. We'll see you Saturday at 10.",
        },
      ],
      durationLabel: "Duration: 4:32",
      handoffMarkers: [
        "NEW LEAD created in VinSolutions via Zapier — Marcus Reyes",
        "Source: Toyota.com, inventory listing 2022 Tacoma TRD Off-Road",
        "Vehicle of interest: VIN ...4421, $34,995 listed",
        "Trade-in: 2018 Tacoma SR5 V6, 78K, clean history",
        "Trade-value range communicated: $22K-$26K subject to appraisal",
        "Financing intent: yes (trade equity reduces to $11K-$13K finance)",
        "Test drive booked: Sat 10 AM with Tony (pre-owned specialist)",
        "90-min appointment: test drive + trade appraisal + finance",
        "Pre-fill credit app link queued for Tony's morning text",
        "Documents requested: title, registration, license, insurance",
        "Lead temperature: HOT (specific VIN, real trade, financing, booked)",
        "Competitor pickup: 3 dealers went to voicemail before us",
      ],
      caption:
        "Four minutes, thirty-two seconds. Hot inventory-specific buyer captured at 7:43 PM after three competitors went to voicemail. Trade-in qualification complete with realistic value range communicated. Test drive booked with the right specialist for Saturday morning, 90-minute slot blocked, credit app pre-fill queued, full documentation list sent. Tony opens Friday morning with a real Tacoma deal already in his calendar — instead of a missed-call list. The competing dealerships find out Monday they lost a deal because nobody answered their phone.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your dealership (~15 minutes)",
        body: "Pick 'Car Dealership.' Add your rooftop(s) and brand(s), your sales team and specialties (new vs. used, EV specialist, fleet specialist, finance specialist), your service department (trades, hours, capacity), your DMS and CRM, your inventory feed, your typical financing partners, your trade-in appraisal workflow, your BDC structure (if you have one — Neverr augments rather than replaces). Connect CDK, Reynolds & Reynolds, DealerSocket, VinSolutions, ELEAD1ONE, or DealerCenter via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your sales line, your service line, or both. Sub-second answer. Inventory-specific qualification. Trade-in capture. Test drive and service appointment booking. Full handoff to your BDC during the day, after-hours capture overnight.",
      },
    ],
    whatItHandles: [
      "Sales: inventory-specific inquiries (VIN-level availability, pricing, options)",
      "Sales: trade-in capture (year, trim, mileage, condition, value range communicated)",
      "Sales: financing vs. lease vs. cash routing, test drive booking with the right specialist",
      "Sales: pre-approval and credit app pre-fill workflow, multi-rooftop routing",
      "Sales: after-hours full sales qualification (the 56% of leads we own)",
      "Service: appointment booking (oil change, tire rotation, recall, warranty, repair, diagnostic)",
      "Service: symptom-based triage ('check engine light,' 'weird sound') to right service advisor",
      "Service: recall lookup and proactive scheduling, loaner car coordination",
      "Service: warranty vs. customer-pay routing, multi-make service",
      "Existing customer recognition — phone-number lookup surfaces full DMS history",
      "Service-to-sales handoff (customer in for service mentions interested in upgrading)",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for negotiations, complaints, escalations",
      "Spam filtering — extended-warranty robocalls, 'we have a buyer for your dealership' scams killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the call is the start. After-hours coverage, BDC augmentation, and recall sequences compound the platform's value.",
      blocks: [
        {
          title: "After-hours coverage that recovers $1M+ per store annually.",
          body: "The math is simple — 56% of leads come in after hours, your dealership loses $1M+ per store per year to missed calls, and 70% of voicemail callers call a competitor within 30 minutes. Neverr handles 100% of after-hours calls at sub-second answer with full sales and service qualification. The leads who would have called your competitor at 7:45 PM stay yours.",
        },
        {
          title: "BDC augmentation, not replacement.",
          body: "If you have a BDC, Neverr handles the overflow — peak Monday morning service rush (10-12 AM is the busiest call window), BDC bathroom breaks, lunch coverage, after-hours surge. Calls that need human judgment get transferred with full context; calls that just need booking get booked. Your BDC team focuses on high-value follow-ups and conversion, not on phone triage. If you don't have a BDC, Neverr handles inbound entirely and integrates with your existing salespeople.",
        },
        {
          title: "Recall and warranty campaigns that actually convert.",
          body: "Most dealerships have hundreds of customers with active recalls who haven't responded to the manufacturer letter. Neverr can run automated outreach campaigns ('Marcus, your 2022 Tacoma has an active recall — we have Saturday morning service slots') with one-tap booking. Recall completion rates climb; manufacturer reimbursements grow.",
        },
        {
          title: "Service-to-sales handoff workflow.",
          body: "The customer in for an oil change who mentions their lease is up next month is a sales lead. The customer paying for a $4,000 transmission repair on a 2014 vehicle is a trade-in candidate. Neverr captures these signals during service calls and routes them to your sales team — the kind of internal lead generation that BDCs miss because they're focused on phone triage.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for dealerships. After-hours coverage. Predictable pricing.",
      blocks: [
        {
          title: "Trained on dealerships. Not configured for them.",
          body: "Most AI receptionists are general-purpose tools with an 'automotive' landing page. They don't separate sales from service, don't know that 7-9 AM Monday is service-rush hour, can't run inventory-specific qualification, and have no idea what a trade-in walkthrough looks like. Neverr is trained on dealership workflows — sales BDC patterns, service department triage, multi-rooftop routing, recall management.",
        },
        {
          title: "Sub-second response when 56% of leads come in after hours.",
          body: "The single largest revenue lever in dealership operations is whether someone picks up the phone at 7:43 PM. Neverr does. Every time. Concurrent calls handled, full qualification, full DMS sync. Your competitor's 'leave a message' routes the lead directly to whoever answers next — usually a captive call center or another dealership down the street.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute, no per-lead.",
          body: "Generic answering services and BDC outsourcers charge more during your peak windows — Monday morning service rush, weekend sales rush, end-of-month deal frenzy. Neverr is flat-rate. Your bill in December (year-end push) looks like your bill in February.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the DMS and CRM your dealership already uses.",
      body: STANDARD_INTEGRATION_BODY("dealership management platforms"),
      examples: ["CDK Global", "Reynolds & Reynolds", "DealerSocket", "VinSolutions", "ELEAD1ONE", "DealerCenter", "Dominion DMS"],
    },
    close: {
      headline: "Stop losing $1M+ a year to voicemail.",
      subhead:
        "Dealerships using AI receptionists capture 56% of after-hours leads, reduce service no-shows, and recover $853K+ in annual service revenue per store. Try Neverr free for 7 days. Augments your BDC. Replaces nothing your team is good at.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Car Dealerships — AI Receptionist for Sales & Service",
      description:
        "Dealership-trained AI receptionist with sales/service split, inventory-aware qualification, BDC augmentation, and DMS integration via Zapier (CDK, Reynolds, DealerSocket, VinSolutions). Recover $1M+ per store. Try free for 7 days.",
    },
  },

  // ==========================================================================
  // WAVE 3 — Glass Repair + Locksmiths + Mortgage Brokers + Plastic Surgery
  // (added 2026-05-07)
  // ==========================================================================
  {
    slug: "glass-repair",
    name: "Glass Repair",
    category: "home-services",
    emoji: "🪟",
    featured: true,
    shortPitch:
      "Auto + storefront emergency dispatch, insurance claim intake, board-up vs replacement triage.",
    hero: {
      headline: "Never miss another after-hours storefront break-in.",
      subhead:
        "Neverr is the AI receptionist trained for glass shops. It triages auto from residential from commercial in the first 30 seconds, captures insurance claim intake correctly, dispatches the right tech for board-up vs same-day replacement, and quotes the work without giving away the wrong price — sub-second answer, every time.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it dispatches a 2 AM board-up",
    },
    pain: [
      {
        title: "It can't tell a chipped windshield from a shattered storefront.",
        body: "A windshield chip is a 30-minute mobile repair that bills to insurance. A shattered storefront at 11 PM is an emergency board-up tonight, plate-glass replacement next morning, and a property insurance claim. A residential shower door is yet another job entirely. Generic AI books 'glass appointment' and your dispatcher discovers the mismatch when the mobile tech rolls up to a broken storefront with no plywood on the truck.",
      },
      {
        title: "It can't capture insurance claim intake.",
        body: "Auto glass calls need carrier, claim number, deductible, VIN, glass coverage type. Commercial calls need property carrier, policy number, on-site contact, and whether the building is secured. Generic AI captures 'name and phone' and your billing team plays detective for 20 minutes per ticket — or worse, the customer pays out-of-pocket because nobody asked the right questions at intake.",
      },
      {
        title: "It quotes one price for every job and gives the work away.",
        body: "An after-hours emergency board-up isn't the same money as a next-day windshield replacement. A laminated security-glass storefront isn't the same as a single-pane door. Generic AI hears 'broken glass' and quotes the cheapest job on your list. The customer is shocked at the real number and the deal evaporates before your tech leaves the shop.",
      },
    ],
    proof: {
      title: "Watch Neverr handle a storefront break-in at 2:14 AM.",
      setup:
        "Wednesday, 2:14 AM. Property manager just got an alarm-company call — front window of a tenant's retail space is shattered. Existing commercial account, recognized by phone number lookup.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Westfield Glass, after-hours emergency line. How can I help?",
        },
        {
          speaker: "Caller",
          text: "Hi, this is Dana from Hilltop Property Management — the alarm company just called. The front window at our tenant on 5th Street is broken. Looks like a break-in. I need someone out there to board it up tonight before another car drives by and somebody walks in.",
        },
        {
          speaker: "Neverr",
          text: "Got it, Dana — I have your account up. We've boarded for Hilltop a few times. Quick questions and I'll dispatch right away. Is the property secured at the moment, or is the opening still wide open with merchandise visible?",
        },
        {
          speaker: "Caller",
          text: "Wide open. The alarm company can't get there for another hour and the police already cleared the scene. Tenant is a clothing boutique — there's product right inside the window.",
        },
        {
          speaker: "Neverr",
          text: "Okay, that's a priority dispatch. I'm sending Marco — he's our after-hours commercial board-up tech and he carries pre-cut plywood for storefronts. He's about 40 minutes out. Address is the 5th Street location at 218 5th, correct?",
        },
        { speaker: "Caller", text: "Yes, 218 5th Street. The tenant is Lumen Boutique." },
        {
          speaker: "Neverr",
          text: "Got it. Two pieces — first, the board-up tonight runs $485 for an after-hours commercial frontage of that size. Second, we'll measure for the replacement glass on-site and quote the new install separately for tomorrow or Friday, depending on what the opening needs. Sound right for tonight?",
        },
        { speaker: "Caller", text: "Yes, send him. Bill it to the Hilltop master account." },
        {
          speaker: "Neverr",
          text: "Billing to Hilltop master. One more — do you want us to file the property insurance claim on the replacement, or are you handling that with your carrier directly?",
        },
        { speaker: "Caller", text: "We're handling it. I'll get you the claim number tomorrow once I've talked to our adjuster." },
        {
          speaker: "Neverr",
          text: "Perfect. Marco's dispatched, ETA 2:54 AM. You'll get a text in two minutes with his photo, ETA, and a live tracking link. He'll text you on-site photos once the board is up so you have documentation for the claim. We'll call you at 8 AM with the replacement glass quote.",
        },
      ],
      durationLabel: "Duration: 2:48",
      handoffMarkers: [
        "DISPATCHED — Marco Reyes, Truck 3 (after-hours board-up cert), ETA 2:54 AM",
        "Synced to ServiceTitan via Zapier as Job #19245",
        "Account: Hilltop Property Management — billed to master account",
        "Tenant: Lumen Boutique, 218 5th Street",
        "After-hours board-up authorized: $485",
        "Replacement quote: pending on-site measurement, callback 8 AM",
        "Claim handling: customer-direct (carrier TBD)",
        "Dana texted: tech name, photo, ETA, live tracking link",
        "On-site documentation queued: post-board photos to customer for claim file",
      ],
      caption:
        "Two minutes, forty-eight seconds. Commercial after-hours emergency dispatched with full account context, secured-vs-open status confirmed, the right tech with pre-cut plywood rolling, board-up price agreed before the truck moves, replacement quote scheduled for the morning, claim documentation queued — and the property is locked down before the next pedestrian walks past at 3 AM.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your shop (~5 minutes)",
        body: "Pick 'Glass Repair' — we pre-load the playbook. Add your service area, your auto vs residential vs commercial split, your mobile units, your after-hours board-up rules, your insurance direct-bill arrangements, and your common job pricing ranges. Connect GlassBiz, GlasPacLX, Mitchell, eDirectGlass, or your FSM via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Auto / residential / commercial triage in the first 30 seconds. Insurance intake captured. Board-ups dispatched in under five minutes after-hours. Jobs synced to your shop management system.",
      },
    ],
    whatItHandles: [
      "Auto vs residential vs commercial triage in the first 30 seconds",
      "After-hours emergency board-up dispatch with the right tech and pre-cut materials",
      "Insurance claim intake — carrier, claim number, deductible, VIN (auto), property policy (commercial)",
      "Direct-bill arrangements with major auto insurance carriers",
      "Mobile vs in-shop routing — windshield repair-on-site vs full replacement in the bay",
      "Same-day replacement scheduling for storefronts, shower doors, sliding doors",
      "Plate glass, tempered, laminated, IGU — captures the spec your estimator needs",
      "Storefront commercial accounts — recognized by phone, billed to master account",
      "Service-area filtering — automatic referrals or polite decline outside your radius",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for insurance disputes, complex commercial bids, complaints",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the emergency is the start. Insurance relationships, commercial accounts, and mobile-tech routing compound the platform's value.",
      blocks: [
        {
          title: "Insurance carrier relationship management.",
          body: "Most glass shops have direct-bill arrangements with several auto insurance carriers — Geico, State Farm, Progressive, Allstate, Liberty Mutual. Neverr captures the carrier on every auto call, queues the right pre-authorization workflow, and surfaces a per-carrier dashboard showing claim cycle times, approval rates, and which adjusters move fast. Your billing team stops chasing approvals and starts forecasting cash flow.",
        },
        {
          title: "Commercial account dashboard for property managers and dealerships.",
          body: "Property management companies, auto dealerships, and HOAs are recurring revenue if you make their lives easy. Neverr captures every commercial call by account, queues service-history-aware responses, and surfaces a per-account dashboard showing call volume, ticket value, and renewal-window flags. The accounts that quietly grow stay; the ones that quietly slip get a proactive check-in.",
        },
        {
          title: "Mobile-unit dispatch optimization.",
          body: "Auto glass and residential repairs are mostly mobile work. Neverr captures the job ZIP, the time window, and the parts spec, and surfaces a routing view that helps your dispatcher pack each truck's day intelligently — not the chaos of 'whoever called first gets the next slot.' Tech utilization climbs without adding headcount.",
        },
        {
          title: "Recovery campaigns for past customers.",
          body: "A windshield customer from 18 months ago is a future customer — chips happen, kids open doors into car windows, the same household has another vehicle. Neverr's SMS sequences re-engage past auto and residential customers with seasonal touchpoints (spring storm season, fall hailstorm prep), keeping your name in their phone before the next chip shows up.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for glass. Emergency-grade dispatch. Predictable pricing.",
      blocks: [
        {
          title: "Trained on glass repair. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'glass shop' landing page. They don't know that a chipped windshield is a 30-minute mobile job and a shattered storefront is a midnight board-up plus a next-day plate-glass install, that auto insurance direct-bill arrangements need different intake from property insurance claims, that storefront board-up is its own pricing category. Neverr is trained on glass-shop intake patterns, insurance workflows, and emergency dispatch.",
        },
        {
          title: "Sub-second response when the storefront is wide open at 2 AM.",
          body: "Property managers and store owners don't wait for voicemail when the alarm just went off. Neverr answers in under a second, runs the secured-vs-open triage, dispatches the right tech with the right materials. That speed is the difference between your shop boarding it up and the customer calling the next number on their list.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "Generic answering services punish you exactly when you need them most — storm weeks, post-hailstorm windshield surges, after-hours commercial emergencies. Neverr is flat-rate. Your November bill looks like your June bill.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the shop management software your team already uses.",
      body: STANDARD_INTEGRATION_BODY("glass-shop management platforms"),
      examples: ["GlassBiz", "GlasPacLX", "Mitchell Glass", "eDirectGlass", "Quest Magic", "ServiceTitan"],
    },
    close: {
      headline: "Stop sending after-hours emergencies to the next shop on the list.",
      subhead:
        "Glass shops using AI receptionists capture 80%+ of after-hours emergency calls and book 30-50% more direct-bill auto claims in the first month. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Glass Repair — AI Receptionist for Auto, Residential & Commercial Shops",
      description:
        "Glass-shop-trained AI receptionist with auto/residential/commercial triage, insurance direct-bill intake, after-hours board-up dispatch, and shop management integration via Zapier (GlassBiz, GlasPacLX, Mitchell). Try free for 7 days.",
    },
  },

  {
    slug: "locksmiths",
    name: "Locksmiths",
    category: "home-services",
    emoji: "🔐",
    featured: true,
    shortPitch:
      "Lockout dispatch, identity verification, automotive vs residential vs commercial routing.",
    hero: {
      headline: "Never miss another 2 AM lockout call.",
      subhead:
        "Neverr is the AI receptionist trained for locksmiths. It triages residential lockouts from automotive transponder jobs from commercial rekeys, runs the identity verification a real dispatcher would, quotes after-hours rates honestly upfront, and dispatches the right tech with the right tools — sub-second answer, every time.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it handles a 2 AM lockout",
    },
    pain: [
      {
        title: "It can't tell three completely different jobs apart.",
        body: "A residential lockout is a 20-minute pick-and-go. An automotive transponder reprogram needs a tech with the right OEM key blanks and the diagnostic equipment for that make. A commercial high-security rekey is a multi-hour Medeco or Mul-T-Lock job that bills 5x the residential rate. Generic AI books 'locksmith needed' and your dispatcher discovers the mismatch when the wrong tech rolls up to the wrong job with the wrong tools.",
      },
      {
        title: "It can't run the identity check a locksmith dispatcher must.",
        body: "When someone calls saying 'let me into this house,' a real locksmith asks for proof — driver's license matching the address, a utility bill, the property owner on the line. Otherwise you're the news story about the locksmith who helped a stranger break into someone's home. Generic AI dispatches blind and exposes you to liability the moment a tech turns the key on a door that wasn't theirs.",
      },
      {
        title: "It gives the after-hours emergency rate away by accident.",
        body: "A 2 AM lockout is a $185 emergency callout, not a $65 daytime service call. Generic AI hears 'lockout' and quotes the cheapest number on your price sheet. The customer agrees, the tech rolls, and you either eat the difference or have an awkward conversation in the driveway at 3 AM that wrecks the review.",
      },
    ],
    proof: {
      title: "Watch Neverr handle an 11:47 PM residential lockout.",
      setup:
        "Tuesday, 11:47 PM. Caller is locked out of her home — got back from a trip, keys are inside, dog is locked inside, no spare with neighbors.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Citywide Locksmith, after-hours line. How can I help?",
        },
        {
          speaker: "Caller",
          text: "Hi, I just got home from a trip and my keys are locked inside the house. My dog is in there alone and I really need to get in tonight.",
        },
        {
          speaker: "Neverr",
          text: "Okay, we can absolutely help with that. First, are you and the dog safe — anyone with you, anyone in the house, any safety concern beyond the lock?",
        },
        { speaker: "Caller", text: "No, just me. Dog is fine, I can hear him. I'm just stuck on the porch." },
        {
          speaker: "Neverr",
          text: "Got it. So you know how this works for after-hours residential — we have to verify it's your home before we open a door. Standard for any reputable locksmith. The fastest way is a driver's license that matches the address. Do you have your wallet on you?",
        },
        { speaker: "Caller", text: "Yes, my wallet is in my purse. License has this address." },
        {
          speaker: "Neverr",
          text: "Perfect. The tech will check it on arrival and we'll be on our way in. Now, address and the type of lock — is it a standard residential deadbolt on the front door, or something else like a smart lock or a high-security cylinder?",
        },
        { speaker: "Caller", text: "412 Westbridge Drive. Standard deadbolt, nothing fancy." },
        {
          speaker: "Neverr",
          text: "Great — that's well within our service area and a straightforward pick. Quick on pricing so there are no surprises in the driveway: after-hours residential lockout is $185 flat. That covers the callout, the lock pick, and getting you in. Most locks open in under 15 minutes. If for some reason the lock has to be drilled and replaced, the tech will quote that separately before he touches it. Sound okay?",
        },
        { speaker: "Caller", text: "Yes, that's fine. How quickly can someone come?" },
        {
          speaker: "Neverr",
          text: "I'm dispatching Marco — he's our after-hours residential tech and he's about 25 minutes out. You'll get a text in two minutes with his photo, ETA, and a live tracking link so you know exactly when he's pulling up. He'll have his license and shop ID on him too. Anything else for tonight?",
        },
        { speaker: "Caller", text: "No, that's everything. Thank you for actually picking up." },
        {
          speaker: "Neverr",
          text: "You bet. Marco will be there shortly. Hang tight — and if anything changes before he arrives, just text this number back.",
        },
      ],
      durationLabel: "Duration: 2:38",
      handoffMarkers: [
        "DISPATCHED — Marco Reyes, Van 4 (residential certified), ETA 12:12 AM",
        "Synced to Housecall Pro via Zapier as Job #6841",
        "Job type: Residential lockout, standard deadbolt",
        "Address: 412 Westbridge Dr (within service area)",
        "ID verification protocol: driver's license check on arrival (license matches address)",
        "After-hours rate disclosed and authorized: $185 flat",
        "Drill-and-replace contingency: separate quote if needed",
        "Customer texted: tech name, photo, ETA, live tracking, shop ID note",
      ],
      caption:
        "Two minutes, thirty-eight seconds. After-hours residential lockout dispatched with the right tech, identity-verification protocol set up before the truck rolls (no more news-story risk), after-hours rate disclosed honestly upfront so there's no awkward conversation in the driveway, Housecall Pro synced. Marco arrives to a customer who already trusts the shop because someone real picked up the phone at midnight.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your shop (~5 minutes)",
        body: "Pick 'Locksmith' — we pre-load the playbook. Add your service area, your residential vs automotive vs commercial split, your tech specializations (transponder programming, high-security cylinders, safe work), your after-hours rates, and your identity-verification rules. Connect ServiceTitan, Housecall Pro, Jobber, FieldEdge, or Service Fusion via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Job-type triage in the first 30 seconds. ID verification protocol applied on residential lockouts. After-hours rates quoted honestly. Right tech dispatched with the right tools.",
      },
    ],
    whatItHandles: [
      "Residential lockout dispatch with identity-verification protocol on arrival",
      "Automotive lockout, key replacement, transponder programming, smart-key cloning",
      "Commercial rekey, master-key systems, high-security cylinder work (Medeco, Mul-T-Lock, ASSA)",
      "Safe-opening jobs — captures safe make/model/type for the right tech",
      "Lock-change and rekey scheduling for new homeowners and tenant turnover",
      "Property management account recognition — recurring tenant turnover billing",
      "Realtor and lockbox-install requests routed to the commercial side",
      "After-hours emergency rate quoted honestly upfront, before dispatch",
      "Service-area filtering — automatic referrals or polite decline outside your radius",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for unusual jobs (forensic, antique safe, automotive ECU)",
      "Spam filtering — extended-warranty robocalls, lead-gen scrapers, scams killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the lockout is the start. Property management accounts, automotive partnerships, and recovery campaigns compound the platform's value.",
      blocks: [
        {
          title: "Property management account dashboard.",
          body: "Property management companies, apartment complexes, and HOAs are recurring revenue — every tenant turnover is a rekey, every move-in is a lock change, every emergency lockout bills to the master account. Neverr captures every property-management call by account, queues the right billing path, and surfaces a per-account dashboard showing call volume, ticket value, and renewal-window flags.",
        },
        {
          title: "Automotive dealership and roadside-assist partnerships.",
          body: "Dealerships need duplicate-key services and transponder programming on used inventory. Roadside-assist networks (AAA, motor clubs, fleet programs) dispatch lockouts to local locksmiths. Neverr recognizes partner accounts by phone number, applies the right billing rate (network rate vs retail), and queues the documentation those programs require for reimbursement.",
        },
        {
          title: "Recovery campaigns for past residential customers.",
          body: "A new-homeowner rekey customer from two years ago is a future customer — they lose keys, they buy a smart lock, they need a safe opened, they refer the neighbor. Neverr's SMS sequences re-engage past residential customers with seasonal touchpoints (back-to-school latchkey kits, holiday-travel spare-key offers) so your name stays in their phone before the next emergency.",
        },
        {
          title: "Mobile-unit dispatch optimization.",
          body: "Locksmith work is almost entirely mobile. Neverr captures the job ZIP, the time window, and the work type, and surfaces a routing view that helps your dispatcher pack each van's day intelligently — high-margin commercial rekeys not bumped by low-margin residential lockouts that don't need the senior tech. Tech utilization climbs without adding headcount.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for locksmiths. Identity-verification aware. Predictable pricing.",
      blocks: [
        {
          title: "Trained on locksmith work. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'locksmith' landing page. They don't know that a residential lockout demands identity verification, that automotive transponder work needs the right key blanks on the truck, that a commercial high-security rekey is a five-figure ticket, or that quoting the daytime rate for a 2 AM job loses money in the driveway. Neverr is trained on locksmith intake patterns, dispatch logic, and the safety protocol a real shop runs.",
        },
        {
          title: "Sub-second response when someone is locked out at midnight.",
          body: "A locked-out customer at 11 PM doesn't wait for voicemail — they call the next shop on Google. Neverr answers in under a second, runs the right triage, and dispatches before your competitor's phone even rings. That speed is the entire business for after-hours work.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "Generic answering services punish you exactly when you need them most — winter (frozen-lock spikes), summer (vacation lockouts), late nights, weekends. Neverr is flat-rate. Your bill in November looks like your bill in February.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the FSM software your dispatcher already uses.",
      body: STANDARD_INTEGRATION_BODY("locksmith FSM platforms"),
      examples: ["ServiceTitan", "Housecall Pro", "Jobber", "FieldEdge", "Service Fusion", "Workiz"],
    },
    close: {
      headline: "Stop losing the 2 AM lockout to whoever picks up first.",
      subhead:
        "Locksmiths using AI receptionists capture 80%+ of after-hours calls, dispatch in under five minutes, and quote after-hours rates honestly upfront — no awkward conversations in the driveway. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Locksmiths — AI Receptionist for After-Hours Lockout Dispatch",
      description:
        "Locksmith-trained AI receptionist with residential/automotive/commercial triage, identity-verification protocol, honest after-hours pricing, and FSM integration via Zapier (ServiceTitan, Housecall Pro, Jobber). Try free for 7 days.",
    },
  },

  {
    slug: "mortgage-brokers",
    name: "Mortgage Brokers",
    category: "professional-services",
    emoji: "🏦",
    featured: true,
    shortPitch:
      "Compliant lead qualification, no rate quotes from AI, licensed-LO callback scheduling, NMLS-aware disclosures.",
    hero: {
      headline: "Never miss another after-hours rate-shopper — without putting your license on the line.",
      subhead:
        "Neverr is the AI receptionist trained for mortgage brokerages. It runs the eight-question qualification a loan officer actually needs, hands rate questions to a licensed LO instead of guessing, asks for SMS consent before texting, and books warm callbacks into your team's calendar — sub-second answer, compliance-aware from the first hello.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it qualifies a rate-shopper after-hours",
    },
    pain: [
      {
        title: "Generic AI either over-promises or burns the lead.",
        body: "Most AI receptionists are configured to sound helpful — which on a mortgage call means quoting a rate the AI invented, hinting that approval is likely, or volunteering payment estimates with no data. That kind of helpful is a TCPA, UDAAP, or state-licensing problem the next morning. The other failure mode is the opposite: the AI asks one question, the prospect feels grilled, hangs up, and your competitor has them by the time you check voicemail at 8 AM.",
      },
      {
        title: "It can't run a real qualification without sounding like an interrogation.",
        body: "A loan officer needs purpose (purchase vs refi vs cash-out), loan amount, property type, occupancy, credit band, down-payment readiness, employment, and timeline before a callback is worth scheduling. Generic AI either asks none of that ('we'll have someone call you tomorrow') or asks all of it like a checklist that makes the caller feel like they're being processed instead of helped. Either way the lead is cold by the time a licensed LO sees it.",
      },
      {
        title: "It texts without consent and skips the disclosures your compliance team requires.",
        body: "A receptionist at a mortgage shop has to ask for SMS consent before sending the appointment confirmation, has to read the standard licensing line on first contact when your business requires it, and has to refuse the rate question instead of inventing a number. Generic AI doesn't know any of that's a rule. The first time a regulator audits your call recordings, the gap shows up in every transcript.",
      },
    ],
    proof: {
      title: "Watch Neverr qualify a 9:14 PM rate-shopper without quoting a rate.",
      setup:
        "Wednesday, 9:14 PM. Caller saw a Google ad for low rates and is comparison-shopping for a refinance. New prospect, no prior file.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Cornerstone Mortgage, this is the after-hours line. How can I help?",
        },
        {
          speaker: "Caller",
          text: "Hey, I'm shopping rates for a refinance. What's your rate today on a 30-year fixed?",
        },
        {
          speaker: "Neverr",
          text: "Great question, and it's the first one everyone asks. The honest answer is rates change daily and depend on your specific situation — credit, loan-to-value, property type, occupancy — so any number I gave you tonight wouldn't be one you could lock anyway. What I can do tonight is grab the basics so a licensed loan officer can pull live pricing for your exact scenario and call you back first thing tomorrow with real numbers. Does that work?",
        },
        { speaker: "Caller", text: "Sure, that's fair. What do you need?" },
        {
          speaker: "Neverr",
          text: "Quick stuff. First, what's the property — single family, condo, multi-unit?",
        },
        { speaker: "Caller", text: "Single family. My primary residence." },
        {
          speaker: "Neverr",
          text: "Got it, single family primary. Roughly what's the home worth today, and roughly what do you owe?",
        },
        { speaker: "Caller", text: "Worth about 720, owe about 460. So loan-to-value is in the mid-60s." },
        {
          speaker: "Neverr",
          text: "Perfect, that's a strong LTV. Are you looking at a straight rate-and-term refinance, or thinking about pulling cash out?",
        },
        { speaker: "Caller", text: "Probably some cash out — maybe 40 to 60 thousand for a kitchen remodel." },
        {
          speaker: "Neverr",
          text: "Got it, rate-and-term plus a small cash-out. Without asking for a number, would you say your credit is in the excellent range — 740 plus — or somewhere below that?",
        },
        { speaker: "Caller", text: "Mid-7s, last I checked." },
        {
          speaker: "Neverr",
          text: "Okay, that's helpful. Last couple — are you a W-2 employee or self-employed, and is there a timeline driving this, like a remodel start date?",
        },
        {
          speaker: "Caller",
          text: "W-2, been at the same company seven years. Remodel is supposed to start in late summer, so I have a little time but want to get the financing piece settled.",
        },
        {
          speaker: "Neverr",
          text: "Perfect, plenty of runway. I have you set up — single family primary, roughly $720K value, $460K owed, looking at a rate-and-term plus $40-60K cash-out, mid-7s credit, W-2 stable employment, summer timeline. I'll get a licensed loan officer to call you back tomorrow morning with live pricing on a few options. Best window — 9 to 10, 10 to 11, or 11 to noon?",
        },
        { speaker: "Caller", text: "10 to 11 works." },
        {
          speaker: "Neverr",
          text: "10 to 11 it is. One last thing — I'd like to send a quick text confirmation with a calendar invite and a secure intake link so the LO has your full picture before the call. Are you okay receiving a text from us at the number you're calling from?",
        },
        { speaker: "Caller", text: "Yes, that's fine." },
        {
          speaker: "Neverr",
          text: "Thank you. SMS consent noted. You'll get the confirmation text in a couple of minutes. Quick disclosure required: Cornerstone Mortgage is a licensed mortgage broker, NMLS ID will be in the text. The LO who calls you tomorrow will go through rates, programs, and any disclosures you need to see in writing. Anything else for tonight?",
        },
        { speaker: "Caller", text: "Nope, that was painless. Thanks." },
      ],
      durationLabel: "Duration: 4:12",
      handoffMarkers: [
        "NEW LEAD CREATED in Encompass via Zapier — qualified refinance prospect",
        "Loan purpose: rate-and-term + ~$40-60K cash-out",
        "Property: single family, primary residence, ~$720K value, ~$460K owed (LTV ~64%)",
        "Credit band (self-reported): mid-7s",
        "Employment: W-2, 7 years tenure",
        "Timeline: summer remodel start",
        "LO callback scheduled: tomorrow 10-11 AM",
        "SMS consent: captured (TCPA-compliant log)",
        "NMLS disclosure: delivered on call + queued in confirmation text",
        "No rates quoted, no approval implied — full transcript on file",
      ],
      caption:
        "Four minutes, twelve seconds. Rate-shopper turned into a fully-qualified refinance lead with a scheduled licensed-LO callback — and not a single rate quoted, not a single approval hinted, SMS consent captured before the text was sent, NMLS disclosure delivered, full call transcript on file for compliance review. The LO opens her morning to a warm lead with eight qualifying answers already in Encompass.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. Card optional during the 7-day trial.",
      },
      {
        step: "02",
        title: "Tell us about your brokerage (~10 minutes)",
        body: "Pick 'Mortgage Broker' — we pre-load the compliance-aware playbook. Add your licensed loan officers and their specialties (purchase vs refi vs commercial vs reverse vs non-QM), your states of operation and NMLS IDs, your standard SMS-consent and disclosure language, and your callback windows. Connect Encompass, LendingPad, BNTouch, Floify, or Calyx Point via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Eight-question qualification run conversationally. Rate questions politely deferred to a licensed LO. SMS consent captured before any text. Warm callback booked into the right LO's calendar.",
      },
    ],
    whatItHandles: [
      "Conversational lead qualification — purpose, loan amount, property type, occupancy, credit band, down payment, employment, timeline",
      "Polite deferral on rate, APR, payment, and approval questions — handed to a licensed loan officer for the callback",
      "SMS consent capture before any text confirmation is sent (TCPA-compliant log)",
      "Standard NMLS / state-licensing disclosure delivered on first contact when configured",
      "Loan officer routing — purchase to one LO, refi to another, commercial or non-QM to a specialist",
      "Callback scheduling into each LO's real availability — not a generic 'someone will call'",
      "Existing-borrower recognition — caller profile flags returning clients, pre-approval status, in-process loans",
      "Realtor and partner-channel intake — captures referring agent, source brokerage, co-marketing flag",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for in-process loan questions, conditions, closing-day issues",
      "Spam filtering — lead-gen scrapers and trigger-lead robocallers killed silently",
      "Full call transcripts retained for compliance review",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the qualified lead is the start. Realtor relationships, in-process borrower communication, and database recovery compound the platform's value.",
      blocks: [
        {
          title: "Realtor referral relationship dashboard.",
          body: "Realtors send loans to brokers who close on time and don't make their buyers feel like a number. Neverr captures every realtor-referred call by source agent, queues per-deal status updates, and surfaces a referring-agent dashboard showing referrals received, pull-through rates, and average close times. Your top realtor relationships become tracked partnerships instead of guesswork.",
        },
        {
          title: "In-process borrower communication that doesn't drop.",
          body: "Loans in process have one universal failure mode: the borrower can't reach their LO at the moment a condition request lands. Neverr recognizes in-process borrowers by phone, surfaces their loan status and outstanding conditions, and triages — answering simple status questions ('did you get my pay stubs?'), capturing condition responses, and routing the urgent stuff to the LO. Closings stop slipping over phone tag.",
        },
        {
          title: "Database recovery for past clients and dormant pre-approvals.",
          body: "Every brokerage has hundreds of past clients who haven't refinanced and dormant pre-approvals that never closed. Neverr's SMS sequences re-engage by life-event window (5-7 years post-purchase for refi candidates, expired pre-approvals for re-engagement) so your LOs are working a warm database instead of buying internet leads.",
        },
        {
          title: "Compliance-aware audit trail on every call.",
          body: "Every call is recorded, transcribed, and tagged. SMS consent moments are flagged. Disclosure delivery is logged. When your QC or a state regulator asks for a sample of calls, you don't go hunting — you pull a report. The audit becomes a checklist instead of a fire drill.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for mortgage brokerages. Compliance-aware. Predictable pricing.",
      blocks: [
        {
          title: "Trained on mortgage intake. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'mortgage' landing page. They don't know to refuse the rate question instead of inventing a number, to ask for SMS consent before texting, to deliver a state-licensing disclosure on first contact, or to route a non-QM call to your non-QM specialist. Neverr is trained on mortgage qualification flow, compliance-aware scripting, and the boundary between helpful AI and a licensed loan officer.",
        },
        {
          title: "Compliance-aware from the first hello.",
          body: "Rate quotes are handed to a licensed loan officer. Approval and qualification outcomes are never promised. SMS consent is captured before any text. Standard NMLS and state-licensing disclosures are delivered when configured. The boundary between an intake conversation and licensed loan advice is enforced on every call — not by a human watching transcripts after the fact, but by the AI itself.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute, no per-lead.",
          body: "Mortgage call volume swings hard with rate moves and seasonal purchase cycles. Generic answering services punish you in the busy weeks (rate-drop days, spring purchase season, end-of-month closing rush). Neverr is flat-rate. Your bill in October looks like your bill in March.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the LOS your processors already work in.",
      body: STANDARD_INTEGRATION_BODY("mortgage LOS and CRM platforms"),
      examples: ["Encompass", "LendingPad", "BNTouch", "Floify", "Calyx Point", "Arive"],
    },
    close: {
      headline: "Stop sending after-hours rate-shoppers to your competitor's voicemail.",
      subhead:
        "Mortgage brokerages using AI receptionists capture 70%+ of after-hours leads with full eight-question qualification — and zero rates quoted, zero approvals promised, every SMS consent captured. Try Neverr free for 7 days.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Mortgage Brokers — Compliance-Aware AI Receptionist",
      description:
        "Mortgage-trained AI receptionist with conversational lead qualification, no rate quotes (handed to licensed LOs), TCPA-compliant SMS consent, NMLS-aware disclosures, and LOS integration via Zapier (Encompass, LendingPad, BNTouch, Floify). Try free for 7 days.",
    },
  },

  {
    slug: "plastic-surgery",
    name: "Plastic Surgery & Cosmetic Dermatology",
    category: "health-wellness",
    emoji: "💎",
    featured: true,
    shortPitch:
      "Consult-first qualification, financing-question handling, post-op symptom triage, HIPAA + signed BAA.",
    hero: {
      headline: "Never miss another after-hours consult inquiry — or a Day-3 post-op call.",
      subhead:
        "Neverr is the AI receptionist trained for plastic surgery and cosmetic dermatology practices. It books consults with the right surgeon and the right time block, handles financing questions without quoting prices, triages post-op symptoms with conservative judgment, and pages the on-call surgeon when something needs to be paged — sub-second answer, HIPAA + BAA from day one.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "See how it triages a Day-3 post-op call",
    },
    pain: [
      {
        title: "It books a 90-minute surgical consult into a 20-minute injectable slot.",
        body: "A tummy-tuck inquiry is a 60-90 minute surgeon consult with a financing pre-screen, photo intake, and medical history. A neurotoxin or filler appointment is a 20-minute injector slot. A laser-resurfacing inquiry needs the cosmetic dermatologist, not the plastic surgeon. Generic AI books 'cosmetic appointment' and your front desk discovers the mismatch Monday morning when a brand-new patient is parked in a 20-minute room expecting an hour with the surgeon.",
      },
      {
        title: "It either gives medical advice or quotes prices it shouldn't.",
        body: "Generic AI hears 'how much is a breast augmentation' and quotes a number from somewhere on your website that's two years old, doesn't include anesthesia, and isn't a quote anyone authorized. Or it hears 'I have asymmetry I want to fix' and starts recommending procedures. Either failure puts the practice in the wrong conversation before the patient ever meets a clinician — and the inquiry that should have become a consult becomes a comparison-shopper.",
      },
      {
        title: "It can't triage a post-op call between 'see you Monday' and 'page the surgeon now.'",
        body: "A Day-3 abdominoplasty patient with increasing drain output, a Day-1 facelift patient with sudden one-sided swelling, a post-injection patient with skin blanching — each of these is a clinical pattern the on-call team needs paged immediately, not a 'we'll call you back tomorrow' from voicemail. Generic AI takes a message and hopes for the best. The complication that should have been a phone call becomes an ER visit and a lawsuit.",
      },
    ],
    proof: {
      title: "Watch Neverr triage a Day-3 post-op call at 8:24 PM.",
      setup:
        "Saturday, 8:24 PM. Practice closed at 5 PM. Caller is a known patient — Day 3 post abdominoplasty (tummy tuck), calling about her surgical drain.",
      transcript: [
        {
          speaker: "Neverr",
          text: "Bayside Plastic Surgery, after-hours line. This is for current patients with post-op questions and consult inquiries — how can I help?",
        },
        {
          speaker: "Caller",
          text: "Hi, I'm three days post-op from a tummy tuck with Dr. Patel. My drain output has gone up today and the fluid looks more pink than yesterday. Should I be worried?",
        },
        {
          speaker: "Neverr",
          text: "I'm so glad you called — that's exactly the kind of question we want to hear from you while you're recovering. I have your chart up. Quick questions and I'll get the on-call surgeon in the loop. First, roughly how much output are you measuring, and how does today's total compare to yesterday's?",
        },
        {
          speaker: "Caller",
          text: "I'm at about 80 milliliters since this morning. Yesterday for the whole day was around 50.",
        },
        {
          speaker: "Neverr",
          text: "Okay. And the color — you said more pink today. Is it pink like watered-down red, or darker like cranberry juice? Any clots in the bulb?",
        },
        { speaker: "Caller", text: "More like watered-down red. No clots that I can see." },
        {
          speaker: "Neverr",
          text: "Got it. Other things — any new fevers, chills, redness or warmth around the incision, sudden swelling on one side more than the other, or any sharp new pain that's different from the soreness you've had?",
        },
        { speaker: "Caller", text: "No fever, no chills. The incision looks the same as yesterday — a little red right at the edges but not spreading. Pain is about the same as yesterday too." },
        {
          speaker: "Neverr",
          text: "Okay, that's a helpful picture. To be safe, this is one I want to get in front of the on-call surgeon tonight rather than wait for Monday. Dr. Patel is on call this weekend. I'm going to page him now and have him call you back. Realistic window is the next 30 to 60 minutes — sometimes faster. Are you safe to wait by your phone, and is the number you're calling from the best one?",
        },
        { speaker: "Caller", text: "Yes, this number is best. I'll be home." },
        {
          speaker: "Neverr",
          text: "Perfect. Two things while you wait — first, if anything changes for the worse before he calls, especially heavy bleeding that soaks a pad in under an hour, sudden severe pain, shortness of breath, or chest pain, that's an emergency and you go straight to the ER and call 911. Don't wait for Dr. Patel to call back. Second, please keep the drain bulb compressed and write down the next output reading — he'll want it. Got it?",
        },
        { speaker: "Caller", text: "Yes, got it. Thank you for actually answering." },
        {
          speaker: "Neverr",
          text: "Of course. Page is going out now. He'll have your chart up when he calls.",
        },
      ],
      durationLabel: "Duration: 3:24",
      handoffMarkers: [
        "ON-CALL SURGEON PAGED — Dr. Patel (weekend on-call rotation)",
        "Patient: existing chart in Symplast, recognized by phone",
        "POD 3 abdominoplasty (procedure date and surgeon confirmed)",
        "Drain output: 80 mL today vs ~50 mL yesterday (trend up)",
        "Fluid color: serosanguinous (pink, watered-red, no clots)",
        "Negatives: no fever/chills, no spreading erythema, no asymmetric swelling, no new sharp pain",
        "ER red-flag instructions delivered: heavy bleeding, severe pain, dyspnea, chest pain → 911",
        "Patient instructed: continue drain compression, log next reading",
        "Callback ETA communicated: 30-60 minutes",
        "Full call transcript queued to chart for Dr. Patel review on callback",
      ],
      caption:
        "Three minutes, twenty-four seconds. Day-3 post-op call triaged with conservative clinical judgment, the right surgeon paged tonight (not 'we'll call you Monday'), full symptom set captured for the callback, ER red-flag instructions delivered explicitly, drain protocol reinforced, full transcript queued to the chart in Symplast. The complication that could have become an ER visit becomes a 30-minute call from the surgeon who already has the picture.",
    },
    howItWorks: [
      {
        step: "01",
        title: "Sign up (~60 seconds)",
        body: "Email + phone number. We sign your BAA at signup — before any patient data flows.",
      },
      {
        step: "02",
        title: "Tell us about your practice (~10 minutes)",
        body: "Pick 'Plastic Surgery & Cosmetic Dermatology' — we pre-load the playbook. Add your surgeons, dermatologists, and injectors with their specialties and consult durations, your published consult fees, your financing partners (CareCredit, Alphaeon, PatientFi), your post-op triage protocols, your on-call rotation, and your published photo and intake requirements. Connect Symplast, Nextech, PatientNow, Aesthetic Record, or Mangomint via Zapier.",
      },
      {
        step: "03",
        title: "Your AI handles calls (live)",
        body: "Forward your number. Sub-second answer. Consult vs treatment vs post-op triage in the first 30 seconds. Right provider, right time block. On-call surgeon paged when post-op symptoms warrant it.",
      },
    ],
    whatItHandles: [
      "Consult inquiry intake — surgical (tummy tuck, breast augmentation, rhinoplasty, facelift) vs minimally invasive (injectables, laser, microneedling)",
      "Right-provider routing — plastic surgeon vs cosmetic dermatologist vs nurse injector",
      "Consult-fee disclosure — published fees only, no procedure pricing quoted by AI",
      "Financing question handling — confirms accepted partners (CareCredit, Alphaeon, PatientFi) without quoting payments or implying approval",
      "Photo and medical-history intake — secure HIPAA-compliant link sent for pre-consult",
      "Post-op symptom triage — captures structured symptom set, escalates to on-call surgeon when criteria are met",
      "ER red-flag escalation language delivered on every triage call",
      "Existing-patient recognition — caller profile flags returning patients, treatment history, payment plan status",
      "Pre-op confirmation calls and reminders, day-of arrival logistics",
      "Bilingual handling — English and Spanish from day one",
      "Live transfer for complex clinical questions, billing disputes, complaints",
      "Spam filtering — extended-warranty robocalls and lead-gen scrapers killed silently",
    ],
    beyondTheCall: {
      headline: "Beyond the call.",
      subhead:
        "Capturing the consult is the start. Conversion sequences, post-op care quality, and recall economics compound the platform's value.",
      blocks: [
        {
          title: "Consult-to-conversion sequences for booked-but-not-yet-scheduled patients.",
          body: "Plastic surgery consults convert at 30-60% — half of the consults in your book never schedule the procedure. Most are not 'no's, they're 'not yets.' Neverr's SMS sequences re-engage by consult date and procedure category ('Hi Maria, it's been six weeks since your breast aug consult with Dr. Patel — surgical scheduling for fall is opening up'), with replies routed back to your patient coordinator. The consults that quietly drift come back without your team chasing.",
        },
        {
          title: "Post-op care quality dashboard.",
          body: "Every post-op triage call is structured, captured, and trended. Your practice manager sees Day-1 / Day-3 / Day-7 call patterns by surgeon, by procedure, by anesthesia type. Patterns that matter — drain-output spikes, asymmetric swelling reports, infection-pattern flags — surface as trend data, not as one-off voicemails the front desk forgot to forward.",
        },
        {
          title: "Recall economics for non-surgical patients.",
          body: "Injectable, laser, and skincare patients are recurring revenue every 3-12 months. Neverr's SMS sequences re-engage by treatment-cycle ('Maria, you're approaching the typical window for your next neurotoxin touch-up') with one-tap booking. Treatment-room utilization climbs without ad spend.",
        },
        {
          title: "Multi-location and multi-provider support.",
          body: "For practices with multiple surgeons, multiple dermatologists, and multiple injectors across one or several locations, Neverr handles centralized intake with provider-specific routing. Each provider has their own specialties, their own consult durations, their own treatment menu — but the platform is one.",
        },
      ],
    },
    whyNeverr: {
      headline: "Built for plastic surgery and cosmetic dermatology. HIPAA-compliant. Predictable pricing.",
      blocks: [
        {
          title: "Trained on cosmetic and aesthetic intake. Not configured for it.",
          body: "Most AI receptionists are general-purpose tools with a 'med spa' landing page. They don't know that a surgical consult and an injectable appointment are different time blocks for different providers, that quoting a breast-augmentation price from the website is a problem and not a service, that a Day-3 post-op call needs a structured triage and not a callback message. Neverr is trained on plastic-surgery and cosmetic-derm intake patterns, consult-first language, and the post-op triage logic that protects patient outcomes.",
        },
        {
          title: "Consult-first language, conservative clinical judgment.",
          body: "Procedure recommendations come from clinicians, not from AI. Pricing comes from the consult, not from the website. Post-op triage errs on the side of paging the on-call surgeon — because the cost of an unnecessary call to a surgeon is small and the cost of a missed complication is enormous. The boundary between intake conversation and clinical advice is enforced on every call.",
        },
        {
          title: "HIPAA, BAA, and audit logging. Standard, not add-on.",
          body: "You sign our BAA at signup. All call data is encrypted in transit and at rest. Role-based access controls and full audit logging on every patient interaction. Required in plastic surgery and cosmetic dermatology; baked into Neverr.",
        },
        {
          title: "Predictable pricing. No per-call, no per-minute.",
          body: "The aesthetic-practice answering service market is full of pricing traps — per-call, per-minute, per-message-relay surcharges that punish you in the busy seasons (pre-summer body work, post-holiday filler season, event-driven facelift cycles). Neverr is flat-rate. Your bill in November looks like your bill in February.",
        },
      ],
    },
    integrations: {
      headline: "Plugs into the practice management software your team already uses.",
      body: STANDARD_INTEGRATION_BODY("aesthetic-practice management platforms"),
      examples: ["Symplast", "Nextech", "PatientNow", "Aesthetic Record", "Mangomint", "RxPhoto"],
    },
    close: {
      headline: "Stop sending after-hours consult inquiries — and Day-3 post-op calls — to voicemail.",
      subhead:
        "Plastic surgery and cosmetic dermatology practices using AI receptionists capture 70%+ of after-hours consult inquiries, triage post-op calls in real time, and recover 25-30% of stalled consults through conversion sequences. Try Neverr free for 7 days — BAA signed at signup, no card required.",
      ctaPrimary: "Try live demo →",
      ctaSecondary: "Talk to sales",
    },
    seo: {
      title: "Neverr for Plastic Surgery & Cosmetic Dermatology — AI Receptionist with Post-Op Triage",
      description:
        "Plastic surgery and cosmetic dermatology AI receptionist with consult-first qualification, financing-question handling, post-op symptom triage, on-call surgeon paging, and PMS integration via Zapier (Symplast, Nextech, PatientNow, Aesthetic Record). HIPAA + signed BAA. Try free for 7 days.",
    },
  },
];

// Export-time validation: every slug must be unique
const _slugs = INDUSTRIES.map((i) => i.slug);
if (_slugs.length !== new Set(_slugs).size) {
  throw new Error(
    "[featured-industries] Duplicate slug detected: " +
      _slugs.filter((s, i) => _slugs.indexOf(s) !== i).join(", ")
  );
}

// Helpers exported for components to consume
export function getIndustryBySlug(slug: string): IndustryBrief | undefined {
  return INDUSTRIES.find((i) => i.slug === slug);
}

export function getIndustriesByCategory(
  category: IndustryCategory
): IndustryBrief[] {
  return INDUSTRIES.filter((i) => i.category === category);
}

export function getFeaturedIndustries(): IndustryBrief[] {
  return INDUSTRIES.filter((i) => i.featured);
}

export function getAllSlugs(): string[] {
  return INDUSTRIES.map((i) => i.slug);
}
