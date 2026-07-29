/**
 * Sprint 3 Stage 3 — prompt template renderer.
 *
 * Extracted from artifacts/api-server/src/routes/api.ts (where this
 * code grew organically). Pure, synchronous: no DB calls, no network
 * I/O, no logging. Callers fetch industry templates + objection
 * handlers upstream and pass the results in via opts.
 *
 * Architecture: Model X (one polyglot prompt per business). The
 * renderer produces an EN-rooted system prompt with LANGUAGE_BLOCKS
 * appended for any additional enabled languages (resolved from
 * opts.languages / spanish_enabled / french_enabled). This is the
 * single source of truth for prompt structure across signup, admin
 * override, customization save, and "Regenerate from helpers"
 * flows.
 *
 * Public exports:
 *   - IndustryTemplate            type
 *   - renderPromptFromHelpers     main entry — the rendered system prompt
 *   - buildMultilingualGreeting   first-message greeting (used by 2 api.ts callers)
 *   - resolveLanguages            language-set helper (used by 2 api.ts callers + internally)
 *
 * Backward-compatibility: routes/api.ts re-exports
 * renderPromptFromHelpers as `buildSystemPrompt` so existing
 * importers (auth.ts:11, admin.ts:39, 5 internal api.ts call sites)
 * keep working unchanged. Stage 4 will migrate those callers and
 * delete the shim.
 */

export interface IndustryTemplate {
  industry_id: string;
  name: string;
  description?: string | null;
  pain_points?: string[] | null;
  value_props?: string[] | null;
  call_scripts?: Array<{ name: string; trigger: string; script: string }> | null;
  appointment_types?: string[] | null;
}

const LANGUAGE_BLOCKS: Record<string, { header: string; block: (biz: string) => string; greeting: (biz: string) => string }> = {
  es: {
    header: "IDIOMA / SPANISH LANGUAGE DETECTION",
    block: (biz) => `Eres completamente bilingue en ingles y espanol.
- Si el cliente habla espanol → responde en espanol inmediatamente
- Si el cliente habla ingles → responde en ingles
- Saludo en espanol: "Gracias por llamar a ${biz}. ¿En qué le puedo ayudar?"
- Never mix languages mid-sentence
- Match the caller's language from their very first word`,
    greeting: (biz) => `¡Gracias por llamar a ${biz}! ¿En qué le puedo ayudar?`,
  },
  fr: {
    header: "LANGUE / FRENCH LANGUAGE DETECTION",
    block: (biz) => `Vous etes completement bilingue en anglais et en francais.
- Si le client parle francais → repondez en francais immediatement
- Si le client parle anglais → repondez en anglais
- Salutation en francais: "Merci d'avoir appele ${biz}! Comment puis-je vous aider?"
- Never mix languages mid-sentence
- Match the caller's language from their very first word`,
    greeting: (biz) => `Merci d'avoir appelé ${biz}! Comment puis-je vous aider?`,
  },
  ar: {
    header: "ARABIC LANGUAGE SUPPORT",
    block: (biz) => `أنت تتحدث العربية بطلاقة تامة.
- إذا تحدث العميل بالعربية → رد بالعربية فوراً
- If caller speaks Arabic → respond in Arabic immediately
- Arabic greeting: "شكراً لاتصالك بـ ${biz}. كيف يمكنني مساعدتك؟"
- Support both Modern Standard Arabic and Gulf/Egyptian dialects`,
    greeting: (biz) => `شكراً لاتصالك بـ ${biz}. كيف يمكنني مساعدتك؟`,
  },
  hi: {
    header: "HINDI LANGUAGE SUPPORT",
    block: (biz) => `आप हिंदी में धाराप्रवाह बात कर सकते हैं।
- If caller speaks Hindi → respond in Hindi immediately
- Hindi greeting: "${biz} में आपका स्वागत है। मैं आपकी कैसे सहायता कर सकता हूं?"
- Also understand Hinglish (Hindi-English mix) and respond naturally`,
    greeting: (biz) => `${biz} में आपका स्वागत है। मैं आपकी कैसे सहायता कर सकता हूं?`,
  },
  pt: {
    header: "PORTUGUESE LANGUAGE SUPPORT",
    block: (biz) => `Você fala português fluentemente.
- If caller speaks Portuguese → respond in Portuguese immediately
- Brazilian Portuguese greeting: "Obrigado por ligar para ${biz}! Como posso ajudá-lo hoje?"
- Support both Brazilian and European Portuguese`,
    greeting: (biz) => `Obrigado por ligar para ${biz}! Como posso ajudá-lo hoje?`,
  },
  de: {
    header: "GERMAN LANGUAGE SUPPORT",
    block: (biz) => `Sie sprechen fließend Deutsch.
- If caller speaks German → respond in German immediately
- German greeting: "Danke für Ihren Anruf bei ${biz}! Wie kann ich Ihnen helfen?"`,
    greeting: (biz) => `Danke für Ihren Anruf bei ${biz}! Wie kann ich Ihnen helfen?`,
  },
  it: {
    header: "ITALIAN LANGUAGE SUPPORT",
    block: (biz) => `Parli italiano correntemente.
- If caller speaks Italian → respond in Italian immediately
- Italian greeting: "Grazie per aver chiamato ${biz}! Come posso aiutarla?"`,
    greeting: (biz) => `Grazie per aver chiamato ${biz}! Come posso aiutarla?`,
  },
  nl: {
    header: "DUTCH LANGUAGE SUPPORT",
    block: (biz) => `U spreekt vloeiend Nederlands.
- If caller speaks Dutch → respond in Dutch immediately
- Dutch greeting: "Bedankt voor het bellen naar ${biz}! Hoe kan ik u helpen?"`,
    greeting: (biz) => `Bedankt voor het bellen naar ${biz}! Hoe kan ik u helpen?`,
  },
  pl: {
    header: "POLISH LANGUAGE SUPPORT",
    block: (biz) => `Mówisz biegle po polsku.
- If caller speaks Polish → respond in Polish immediately
- Polish greeting: "Dziękujemy za telefon do ${biz}! Jak mogę pomóc?"`,
    greeting: (biz) => `Dziękujemy za telefon do ${biz}! Jak mogę pomóc?`,
  },
  tr: {
    header: "TURKISH LANGUAGE SUPPORT",
    block: (biz) => `Akıcı Türkçe konuşuyorsunuz.
- If caller speaks Turkish → respond in Turkish immediately
- Turkish greeting: "${biz}'i aradığınız için teşekkürler! Size nasıl yardımcı olabilirim?"`,
    greeting: (biz) => `${biz}'i aradığınız için teşekkürler! Size nasıl yardımcı olabilirim?`,
  },
  ru: {
    header: "RUSSIAN LANGUAGE SUPPORT",
    block: (biz) => `Вы свободно говорите по-русски.
- If caller speaks Russian → respond in Russian immediately
- Russian greeting: "Спасибо за звонок в ${biz}! Как я могу вам помочь?"`,
    greeting: (biz) => `Спасибо за звонок в ${biz}! Как я могу вам помочь?`,
  },
  ja: {
    header: "JAPANESE LANGUAGE SUPPORT",
    block: (biz) => `日本語を流暢に話せます。
- If caller speaks Japanese → respond in Japanese immediately
- Japanese greeting: "${biz}にお電話いただきありがとうございます。ご用件をお伺いします。"
- Use polite keigo (敬語) by default`,
    greeting: (biz) => `${biz}にお電話いただきありがとうございます。ご用件をお伺いします。`,
  },
  ko: {
    header: "KOREAN LANGUAGE SUPPORT",
    block: (biz) => `한국어를 유창하게 구사합니다.
- If caller speaks Korean → respond in Korean immediately
- Korean greeting: "${biz}에 전화해 주셔서 감사합니다. 무엇을 도와드릴까요?"
- Use formal speech (존댓말) by default`,
    greeting: (biz) => `${biz}에 전화해 주셔서 감사합니다. 무엇을 도와드릴까요?`,
  },
  zh: {
    header: "MANDARIN CHINESE LANGUAGE SUPPORT",
    block: (biz) => `您能流利地说普通话。
- If caller speaks Mandarin → respond in Mandarin immediately
- Mandarin greeting: "感谢致电${biz}！请问有什么可以帮您的？"`,
    greeting: (biz) => `感谢致电${biz}！请问有什么可以帮您的？`,
  },
  yue: {
    header: "CANTONESE LANGUAGE SUPPORT",
    block: (biz) => `您能流利地說廣東話。
- If caller speaks Cantonese → respond in Cantonese immediately
- Cantonese greeting: "多謝你打嚟${biz}！有咩可以幫到你？"`,
    greeting: (biz) => `多謝你打嚟${biz}！有咩可以幫到你？`,
  },
  id: {
    header: "INDONESIAN LANGUAGE SUPPORT",
    block: (biz) => `Anda fasih berbahasa Indonesia.
- If caller speaks Indonesian → respond in Indonesian immediately
- Indonesian greeting: "Terima kasih telah menghubungi ${biz}! Ada yang bisa saya bantu?"`,
    greeting: (biz) => `Terima kasih telah menghubungi ${biz}! Ada yang bisa saya bantu?`,
  },
  ms: {
    header: "MALAY LANGUAGE SUPPORT",
    block: (biz) => `Anda fasih berbahasa Melayu.
- If caller speaks Malay → respond in Malay immediately
- Malay greeting: "Terima kasih kerana menghubungi ${biz}! Bagaimana saya boleh membantu?"`,
    greeting: (biz) => `Terima kasih kerana menghubungi ${biz}! Bagaimana saya boleh membantu?`,
  },
  vi: {
    header: "VIETNAMESE LANGUAGE SUPPORT",
    block: (biz) => `Bạn nói tiếng Việt lưu loát.
- If caller speaks Vietnamese → respond in Vietnamese immediately
- Vietnamese greeting: "Cảm ơn bạn đã gọi đến ${biz}! Tôi có thể giúp gì cho bạn?"`,
    greeting: (biz) => `Cảm ơn bạn đã gọi đến ${biz}! Tôi có thể giúp gì cho bạn?`,
  },
  th: {
    header: "THAI LANGUAGE SUPPORT",
    block: (biz) => `คุณพูดภาษาไทยได้คล่อง
- If caller speaks Thai → respond in Thai immediately
- Thai greeting: "ขอบคุณที่โทรหา ${biz} ค่ะ/ครับ! มีอะไรให้ช่วยคะ/ครับ?"`,
    greeting: (biz) => `ขอบคุณที่โทรหา ${biz} ค่ะ! มีอะไรให้ช่วยคะ?`,
  },
  tl: {
    header: "FILIPINO LANGUAGE SUPPORT",
    block: (biz) => `Marunong kang magsalita ng Filipino.
- If caller speaks Filipino → respond in Filipino immediately
- Filipino greeting: "Salamat sa pagtawag sa ${biz}! Paano ko po kayo matutulungan?"`,
    greeting: (biz) => `Salamat sa pagtawag sa ${biz}! Paano ko po kayo matutulungan?`,
  },
  sv: {
    header: "SWEDISH LANGUAGE SUPPORT",
    block: (biz) => `Du talar flytande svenska.
- If caller speaks Swedish → respond in Swedish immediately
- Swedish greeting: "Tack för att du ringer ${biz}! Hur kan jag hjälpa dig?"`,
    greeting: (biz) => `Tack för att du ringer ${biz}! Hur kan jag hjälpa dig?`,
  },
  no: {
    header: "NORWEGIAN LANGUAGE SUPPORT",
    block: (biz) => `Du snakker flytende norsk.
- If caller speaks Norwegian → respond in Norwegian immediately
- Norwegian greeting: "Takk for at du ringer ${biz}! Hvordan kan jeg hjelpe deg?"`,
    greeting: (biz) => `Takk for at du ringer ${biz}! Hvordan kan jeg hjelpe deg?`,
  },
  da: {
    header: "DANISH LANGUAGE SUPPORT",
    block: (biz) => `Du taler flydende dansk.
- If caller speaks Danish → respond in Danish immediately
- Danish greeting: "Tak fordi du ringer til ${biz}! Hvordan kan jeg hjælpe dig?"`,
    greeting: (biz) => `Tak fordi du ringer til ${biz}! Hvordan kan jeg hjælpe dig?`,
  },
  fi: {
    header: "FINNISH LANGUAGE SUPPORT",
    block: (biz) => `Puhut sujuvasti suomea.
- If caller speaks Finnish → respond in Finnish immediately
- Finnish greeting: "Kiitos soitostasi ${biz}:lle! Kuinka voin auttaa?"`,
    greeting: (biz) => `Kiitos soitostasi ${biz}:lle! Kuinka voin auttaa?`,
  },
  ro: {
    header: "ROMANIAN LANGUAGE SUPPORT",
    block: (biz) => `Vorbiți fluent limba română.
- If caller speaks Romanian → respond in Romanian immediately
- Romanian greeting: "Mulțumim că ați sunat la ${biz}! Cu ce vă putem ajuta?"`,
    greeting: (biz) => `Mulțumim că ați sunat la ${biz}! Cu ce vă putem ajuta?`,
  },
  cs: {
    header: "CZECH LANGUAGE SUPPORT",
    block: (biz) => `Mluvíte plynně česky.
- If caller speaks Czech → respond in Czech immediately
- Czech greeting: "Děkujeme za váš hovor do ${biz}! Jak vám mohu pomoci?"`,
    greeting: (biz) => `Děkujeme za váš hovor do ${biz}! Jak vám mohu pomoci?`,
  },
  sk: {
    header: "SLOVAK LANGUAGE SUPPORT",
    block: (biz) => `Hovoríte plynule po slovensky.
- If caller speaks Slovak → respond in Slovak immediately
- Slovak greeting: "Ďakujeme za váš hovor do ${biz}! Ako vám môžem pomôcť?"`,
    greeting: (biz) => `Ďakujeme za váš hovor do ${biz}! Ako vám môžem pomôcť?`,
  },
  hu: {
    header: "HUNGARIAN LANGUAGE SUPPORT",
    block: (biz) => `Folyékonyan beszél magyarul.
- If caller speaks Hungarian → respond in Hungarian immediately
- Hungarian greeting: "Köszönjük, hogy felhívta a ${biz}-t! Miben segíthetek?"`,
    greeting: (biz) => `Köszönjük, hogy felhívta a ${biz}-t! Miben segíthetek?`,
  },
  el: {
    header: "GREEK LANGUAGE SUPPORT",
    block: (biz) => `Μιλάτε άπταιστα ελληνικά.
- If caller speaks Greek → respond in Greek immediately
- Greek greeting: "Ευχαριστούμε που καλέσατε ${biz}! Πώς μπορώ να σας βοηθήσω;"`,
    greeting: (biz) => `Ευχαριστούμε που καλέσατε ${biz}! Πώς μπορώ να σας βοηθήσω;`,
  },
  uk: {
    header: "UKRAINIAN LANGUAGE SUPPORT",
    block: (biz) => `Ви вільно розмовляєте українською.
- If caller speaks Ukrainian → respond in Ukrainian immediately
- Ukrainian greeting: "Дякуємо за дзвінок до ${biz}! Чим можу допомогти?"`,
    greeting: (biz) => `Дякуємо за дзвінок до ${biz}! Чим можу допомогти?`,
  },
  he: {
    header: "HEBREW LANGUAGE SUPPORT",
    block: (biz) => `אתה מדבר עברית שוטפת.
- If caller speaks Hebrew → respond in Hebrew immediately
- Hebrew greeting: "תודה שהתקשרת ל-${biz}! איך אני יכול לעזור?"`,
    greeting: (biz) => `תודה שהתקשרת ל-${biz}! איך אני יכול לעזור?`,
  },
};

export function resolveLanguages(opts: { languages?: string[]; spanish_enabled?: boolean; french_enabled?: boolean }): string[] {
  const langs = new Set<string>();
  if (opts.languages) {
    for (const l of opts.languages) {
      if (l !== "en") langs.add(l);
    }
  }
  if (opts.spanish_enabled) langs.add("es");
  if (opts.french_enabled) langs.add("fr");
  return Array.from(langs);
}

export function renderPromptFromHelpers(opts: {
  business_name: string;
  industry: string;
  owner_name?: string;
  business_hours: string;
  services?: string;
  website?: string;
  phone_number?: string;
  timezone: string;
  languages?: string[];
  spanish_enabled?: boolean;
  french_enabled?: boolean;
  industryTemplate?: IndustryTemplate | null;
  websiteContext?: string | null;
  customFaqs?: Array<{ question: string; answer: string }> | null;
  objectionHandling?: Array<{ objection: string; response: string }> | null;
  objectionHandlersFromTable?: Array<{ objection_phrase: string; ai_response: string; objection_category?: string }> | null;
  tonePreference?: string | null;
  neverSayList?: string[] | null;
  // Phase 3.2b — the business's department / topic catalogue from
  // business_configs.departments. When populated, renders a
  // DEPARTMENTS & TOPIC EXPERTISE section that Alex uses to pick the
  // right topic_slug when invoking the route_to_topic tool. Omitting
  // topics is safe — the section is skipped and no routing hint appears
  // in the prompt (route_to_topic tool won't be registered in that
  // case either — see agents.ts:updateAgentTools guard).
  topics?: Array<{
    slug: string;
    name: string;
    description?: string | null;
    example_utterances?: string[] | null;
  }> | null;
}): string {
  const tmpl = opts.industryTemplate;
  const industryLabel = tmpl?.name || opts.industry;

  let prompt = `You are Alex, the professional AI receptionist for ${opts.business_name}, a ${industryLabel} business.

BUSINESS INFORMATION:
- Business Name: ${opts.business_name}
- Industry: ${industryLabel}
- Owner: ${opts.owner_name || "the business owner"}
- Business Hours: ${opts.business_hours} (${opts.timezone})
- Phone: ${opts.phone_number || "on file"}
- Website: ${opts.website || "available upon request"}
${opts.services ? "- Services: " + opts.services : ""}`;

  if (opts.websiteContext && opts.websiteContext.trim().length > 0) {
    prompt += `

BUSINESS WEBSITE CONTEXT (specific details about THIS business pulled from their website — use these facts over generic assumptions, and never contradict what's here):
${opts.websiteContext.trim()}`;
  }

  if (tmpl?.description) {
    prompt += `

ABOUT THIS INDUSTRY:
${tmpl.description}`;
  }

  if (tmpl?.pain_points && tmpl.pain_points.length > 0) {
    prompt += `

COMMON CALLER CONCERNS (what people calling ${opts.business_name} are typically worried about or trying to solve):
${tmpl.pain_points.map(p => `- ${p}`).join("\n")}`;
  }

  if (tmpl?.value_props && tmpl.value_props.length > 0) {
    prompt += `

HOW YOU HELP CALLERS (the specific value you provide — use these to guide your responses):
${tmpl.value_props.map(v => `- ${v}`).join("\n")}`;
  }

  if (tmpl?.call_scripts && tmpl.call_scripts.length > 0) {
    prompt += `

CALL PLAYBOOK — Use these scripts when the situation matches the trigger.
These are calibrated specifically for ${industryLabel} businesses. Adapt the
phrasing to the caller's tone but follow the structure and information gathering
steps closely.
`;
    for (const s of tmpl.call_scripts) {
      prompt += `
### ${s.name}
When this happens: ${s.trigger}
How to handle: ${s.script}
`;
    }
  }

  if (tmpl?.appointment_types && tmpl.appointment_types.length > 0) {
    prompt += `

APPOINTMENT TYPES you can help schedule:
${tmpl.appointment_types.map(a => `- ${a}`).join("\n")}`;
  }

  // Phase 3.2b — DEPARTMENTS & TOPIC EXPERTISE. Anchor for Alex to
  // pick the right topic_slug when invoking route_to_topic. Renders
  // slug + display name + description + up-to-4 example utterances
  // (few-shot anchors from the seed catalogue in migration 036 or
  // customer edits via /settings?tab=topics).
  //
  // The tool description in agents.ts:ROUTE_TO_TOPIC_DESCRIPTION
  // cross-references this section by name — keep the heading string
  // stable to preserve the LLM's mental link.
  if (opts.topics && opts.topics.length > 0) {
    prompt += `

DEPARTMENTS & TOPIC EXPERTISE (when a caller's request matches one of these topics AND requires a real human on the phone, invoke the route_to_topic tool with the matching topic_slug — the routing engine will ring the on-duty specialist and connect them to the caller):
`;
    for (const topic of opts.topics) {
      const desc = (topic.description || "").trim();
      const utterances = Array.isArray(topic.example_utterances)
        ? topic.example_utterances
            .filter((u) => typeof u === "string" && u.trim().length > 0)
            .slice(0, 4)
        : [];
      prompt += `
- topic_slug: "${topic.slug}" — ${topic.name}`;
      if (desc) prompt += `
  ${desc}`;
      if (utterances.length > 0) {
        prompt += `
  Example utterances the caller might say: ${utterances.map((u) => `"${u.trim()}"`).join(", ")}`;
      }
    }
    prompt += `

Do NOT invoke route_to_topic for simple questions you can answer yourself (business hours, address, general policies). Do NOT invoke it for scheduling — use record_appointment for that. Only invoke when the caller needs a specialist right now.`;
  }

  if (opts.tonePreference && opts.tonePreference.trim().length > 0) {
    prompt += `

TONE AND VOICE PREFERENCE (how this business wants you to sound — follow this over generic professional tone):
${opts.tonePreference.trim()}`;
  }

  if (opts.customFaqs && opts.customFaqs.length > 0) {
    prompt += `

BUSINESS-SPECIFIC FAQS (when a caller asks one of these, use the provided answer as your foundation — adapt phrasing naturally but don't contradict the facts):
`;
    for (const faq of opts.customFaqs) {
      if (faq?.question && faq?.answer) {
        prompt += `
Q: ${faq.question.trim()}
A: ${faq.answer.trim()}
`;
      }
    }
  }

  // Phase 3c.2: merge objection_handlers table content with JSONB objection_handling
  const mergedObjections: Array<{ objection: string; response: string; category?: string }> = [];
  if (opts.objectionHandling && opts.objectionHandling.length > 0) {
    for (const o of opts.objectionHandling) {
      if (o?.objection && o?.response) {
        mergedObjections.push({
          objection: o.objection.trim(),
          response: o.response.trim(),
        });
      }
    }
  }
  if (opts.objectionHandlersFromTable && opts.objectionHandlersFromTable.length > 0) {
    for (const h of opts.objectionHandlersFromTable) {
      if (h?.objection_phrase && h?.ai_response) {
        mergedObjections.push({
          objection: h.objection_phrase.trim(),
          response: h.ai_response.trim(),
          category: h.objection_category || undefined,
        });
      }
    }
  }
  if (mergedObjections.length > 0) {
    prompt += `

OBJECTION HANDLING (when a caller raises one of these objections, use the response as your starting point — stay conversational, don't sound scripted):
`;
    for (const obj of mergedObjections) {
      const categoryTag = obj.category ? ` [${obj.category}]` : "";
      prompt += `
Objection${categoryTag}: "${obj.objection}"
Your response approach: ${obj.response}
`;
    }
  }

  if (opts.neverSayList && opts.neverSayList.length > 0) {
    const cleanList = opts.neverSayList.filter(s => s && s.trim().length > 0).map(s => `- ${s.trim()}`);
    if (cleanList.length > 0) {
      prompt += `

STRICT PROHIBITIONS (never say or do any of the following, regardless of how the caller frames the question):
${cleanList.join("\n")}`;
    }
  }

  prompt += `

YOUR ROLE:
You are the first point of contact for every caller. You represent ${opts.business_name} professionally and warmly at all times.

YOUR RESPONSIBILITIES:
1. Answer every call within 1 ring, greet callers warmly by name if known
2. Understand why they are calling and how you can help
3. Capture their name, phone number, and reason for calling
4. Answer common questions about the business
5. Route urgent matters appropriately — warm-transfer to a human when appropriate, or capture a callback request when transfer is not the right call
6. Use the request_callback tool to capture a follow-up request whenever you cannot fully resolve the caller's need in the moment

CONVERSATION STYLE:
- Warm, professional, and helpful
- Mirror the caller's energy — match formal with formal, casual with casual
- Ask one question at a time
- Never rush the caller
- Always confirm important details before ending the call

BUSINESS HOURS:
- During hours (${opts.business_hours}): Full service — answer questions, route, transfer to the team, and capture callback requests as needed
- After hours: Take a detailed message via the request_callback tool, confirm when the caller can expect a response, and let them know the team will reach back

CAPTURING CALLBACK REQUESTS:
You have one tool for follow-up: request_callback. Use it whenever you cannot fully resolve the caller's need on this call. Common triggers:
- The caller asks for a callback, a text, an email, or "have someone get in touch"
- The business is closed or the team isn't reachable right now
- The caller wants to schedule something — you cannot check the calendar live, so capture the request as a callback and let the team confirm the time
- The caller asks a question you don't have an answer for and warm-transfer isn't appropriate (caller declines, or no operator is available)
- A non-urgent follow-up where the caller doesn't need real-time help

Before invoking the tool, confirm these out loud with the caller, one item at a time:
1. Their full name (contact_name)
2. The best phone number to reach them at (contact_phone) — read it back digit by digit to confirm
3. A brief reason in their own words (reason) — what should the team know before calling back
4. Urgency (urgency) — gauge from their words and tone:
   - emergency: something happening right now needing immediate human attention
   - high: same-day, time-sensitive
   - medium: the default for normal callbacks
   - low: informational, no rush
5. Preferred channel (preferred_channel) — ask: "Would you prefer a text, a call, or an email?"

Acknowledge verbally BEFORE invoking the tool so the caller hears you taking action — for example: "Got it — let me get that down so someone from the team can follow up. The best number is the one you just gave me?" Then invoke request_callback with the confirmed details.

After the tool returns success, close the loop verbally — for example: "All set — I've passed this on to the team. They'll reach out by text, call, or email shortly." If urgency is high or emergency, give an explicit timeframe ("within the hour", "today").

If the tool returns an error, do NOT retry silently. Apologize briefly, take the same information verbally so the team can follow up manually, and end the call warmly.

CRITICAL RULES:
- NEVER make up information you don't know — capture a request_callback so the team can follow up
- NEVER tell a caller the business is closed without offering to take a message via request_callback
- NEVER promise live appointment confirmation — you cannot check the calendar; route scheduling intent through request_callback
- ALWAYS confirm phone number and reason back to the caller before invoking request_callback
- Speak naturally — avoid sounding robotic or scripted`;

  const enabledLangs = resolveLanguages(opts);

  for (const code of enabledLangs) {
    const lb = LANGUAGE_BLOCKS[code];
    if (lb) {
      prompt += `\n\n${lb.header}:\n${lb.block(opts.business_name)}`;
    }
  }

  if (enabledLangs.length > 0) {
    prompt += `\n\nMULTILINGUAL RULES:
- Never mix languages mid-sentence
- Match the caller's language from their very first word
- If unsure of the language, respond in English first`;
  }

  return prompt;
}

export function buildMultilingualGreeting(opts: {
  business_name: string;
  languages?: string[];
  spanish_enabled?: boolean;
  french_enabled?: boolean;
}): string {
  let greeting = `Thank you for calling ${opts.business_name}! How can I help you today?`;
  const enabledLangs = resolveLanguages(opts);
  const top3 = enabledLangs.slice(0, 3);
  for (const code of top3) {
    const lb = LANGUAGE_BLOCKS[code];
    if (lb) {
      greeting += ` / ${lb.greeting(opts.business_name)}`;
    }
  }
  return greeting;
}
