export interface CulturalProfile {
  name: string;
  formality: string;
  greeting_style?: string;
  communication_pace?: string;
  relationship_emphasis?: string;
  directness?: string;
  time_orientation?: string;
  greeting_phrases?: string[];
  style_notes: string;
}

export const CULTURAL_PROFILES: Record<string, CulturalProfile> = {
  'es-MX': {
    name: 'Mexican Spanish',
    formality: 'warm_informal',
    greeting_style: 'familial',
    communication_pace: 'moderate',
    relationship_emphasis: 'high',
    directness: 'low',
    time_orientation: 'flexible',
    greeting_phrases: [
      '¡Buenos días! ¿Cómo le puedo ayudar hoy?',
      '¡Hola! Bienvenido a [Business]. ¿En qué le puedo servir?'
    ],
    style_notes: `Use warm, familial tone. Address as "usted" initially but follow their lead. Build rapport before business. Mexicans appreciate warmth and personal connection. Use "por favor" and "con mucho gusto" frequently. Be patient — rushing feels rude.`
  },
  'es-CO': {
    name: 'Colombian Spanish',
    formality: 'formal_warm',
    greeting_style: 'professional',
    communication_pace: 'moderate',
    relationship_emphasis: 'high',
    directness: 'moderate',
    greeting_phrases: [
      '¡Buenos días! ¿Con quién tengo el gusto?',
      'Bienvenido a [Business]. ¿En qué le puedo colaborar?'
    ],
    style_notes: `More formal than Mexican Spanish. Always use "usted". "Colaborar" instead of "ayudar" is preferred. Bogotanos are very formal and professional. Compliments are appreciated and genuine.`
  },
  'es-US': {
    name: 'US Hispanic Spanish',
    formality: 'casual_bilingual',
    greeting_style: 'American_influenced',
    communication_pace: 'fast',
    directness: 'moderate_high',
    style_notes: `Many US Hispanic callers code-switch between English and Spanish. Be ready to respond in whichever language they use most. More direct than Latin American Spanish. OK to be more casual and efficient.`
  },
  'ar-EG': {
    name: 'Egyptian Arabic',
    formality: 'warm_moderate',
    greeting_style: 'religious_cultural',
    communication_pace: 'expressive',
    relationship_emphasis: 'very_high',
    directness: 'indirect',
    greeting_phrases: [
      'السلام عليكم، أهلاً وسهلاً',
      'أهلاً بيك! إزيك النهارده؟'
    ],
    style_notes: `Egyptians are warm and expressive communicators. Religious greetings (As-salamu alaykum) are appropriate. Build personal rapport first — business is secondary. Egyptians appreciate humor and warmth. Egyptian Arabic is widely understood across Arab world.`
  },
  'ar-SA': {
    name: 'Gulf/Saudi Arabic',
    formality: 'formal_respectful',
    greeting_style: 'formal_religious',
    communication_pace: 'deliberate',
    relationship_emphasis: 'high',
    directness: 'indirect',
    style_notes: `Very formal register required initially. Religious greetings mandatory: As-salamu alaykum. Title and respect extremely important. Allow time for pleasantries — never rush. Privacy and discretion highly valued.`
  },
  'ar-MA': {
    name: 'Moroccan Arabic (Darija)',
    formality: 'casual_warm',
    communication_pace: 'fast',
    style_notes: `Moroccan Darija is very different from Modern Standard Arabic. Mix of Arabic, French, Berber. Many Moroccans prefer French for formal matters. Offer to switch to French if needed. Warm but efficient communication style.`
  },
  'fr-FR': {
    name: 'Metropolitan French',
    formality: 'formal',
    greeting_style: 'professional_reserved',
    communication_pace: 'measured',
    directness: 'moderate',
    greeting_phrases: [
      'Bonjour, [Business], comment puis-je vous aider?',
      'Bonjour! En quoi puis-je vous être utile?'
    ],
    style_notes: `French callers expect professional, precise language. Use "vous" always — never "tu" with strangers. Avoid excessive enthusiasm — it seems insincere. Be direct and logical in explanations. Acknowledge complexity — French appreciate nuance.`
  },
  'fr-CA': {
    name: 'Canadian French (Québécois)',
    formality: 'casual_warm',
    greeting_style: 'friendly',
    style_notes: `More casual than European French. "Tu" is acceptable earlier in conversation. Québécois expressions differ from France French. Warmer and more American-influenced in style. Very proud of French language — always use French.`
  },
  'fr-CI': {
    name: "West African French (Côte d'Ivoire)",
    formality: 'warm_respectful',
    style_notes: `West African French is warm and relationship-oriented. Greetings are very important — never skip them. Respect for elders and authority is paramount. Indirect communication style. May mix French with local language expressions.`
  },
  'pt-BR': {
    name: 'Brazilian Portuguese',
    formality: 'casual_warm',
    greeting_style: 'enthusiastic',
    communication_pace: 'fast_expressive',
    directness: 'moderate',
    greeting_phrases: [
      'Olá! Tudo bem? Como posso te ajudar?',
      'Oi! Seja bem-vindo(a) à [Business]!'
    ],
    style_notes: `Brazilians are very warm and expressive. Use "você" — "tu" varies by region. Build rapport quickly — Brazilians are friendly. Enthusiasm and positivity are welcome. Very different from European Portuguese.`
  },
  'pt-PT': {
    name: 'European Portuguese',
    formality: 'formal_reserved',
    style_notes: `More formal and reserved than Brazilian Portuguese. Use "o senhor/a senhora" for formal address. Less expressive than Brazilian style. Direct but polite.`
  },
  'zh-CN': {
    name: 'Mandarin (Simplified/Mainland)',
    formality: 'respectful_formal',
    greeting_style: 'professional',
    communication_pace: 'measured',
    directness: 'indirect',
    style_notes: `Respect and hierarchy are fundamental. Avoid causing "face loss" at all costs. Frame negatives indirectly. Be patient — decisions take time. Professional titles matter greatly.`
  },
  'zh-TW': {
    name: 'Mandarin (Traditional/Taiwan)',
    formality: 'polite_warm',
    style_notes: `Similar to mainland but slightly warmer. Traditional characters and different vocabulary. Very polite and service-oriented expectations.`
  },
  'hi-IN': {
    name: 'Hindi (India)',
    formality: 'respectful',
    greeting_style: 'formal_warm',
    style_notes: `Use "Aap" (formal you) not "tum" with strangers. Respect for education and professional status. Indirect communication for negative information. Family context is often relevant to decisions. English mix (Hinglish) is common — follow their lead.`
  },
  'ko-KR': {
    name: 'Korean',
    formality: 'hierarchical_formal',
    style_notes: `Formal speech levels are critical in Korean. Use formal speech always initially. Age and status determine appropriate speech level. Indirect communication for sensitive topics. Punctuality and efficiency are valued.`
  },
  'en-US': {
    name: 'American English',
    formality: 'casual_professional',
    greeting_style: 'friendly_efficient',
    communication_pace: 'moderate_fast',
    directness: 'high',
    style_notes: `Friendly but efficient. Get to the point. First names are fine after introduction. Positivity and can-do attitude expected. Direct questions are appropriate.`
  }
};

export function detectCulturalProfile(language: string, transcript: string, _callerPhone: string): string {
  const lower = transcript.toLowerCase();

  if (language.startsWith('es')) {
    if (lower.includes('colaborar') || lower.includes('parcero')) return 'es-CO';
    if (lower.includes('wey') || lower.includes('güey') || lower.includes('órale')) return 'es-MX';
    return 'es-US';
  }

  if (language.startsWith('ar')) {
    if (lower.includes('إزيك') || lower.includes('أهلاً') || transcript.includes('إزيك')) return 'ar-EG';
    if (lower.includes('darija') || transcript.includes('واش')) return 'ar-MA';
    return 'ar-SA';
  }

  if (language.startsWith('fr')) {
    if (lower.includes('ostie') || lower.includes('câlisse') || lower.includes('tabernac')) return 'fr-CA';
    return 'fr-FR';
  }

  if (language.startsWith('pt')) {
    if (lower.includes('tudo bem') || lower.includes('oi') || lower.includes('você')) return 'pt-BR';
    return 'pt-PT';
  }

  if (language.startsWith('zh')) {
    return language.includes('TW') ? 'zh-TW' : 'zh-CN';
  }

  if (language.startsWith('hi')) return 'hi-IN';
  if (language.startsWith('ko')) return 'ko-KR';

  return language || 'en-US';
}

export function buildCulturalPrompt(language: string, transcript: string, callerPhone: string, businessName?: string): string {
  const profileKey = detectCulturalProfile(language, transcript, callerPhone);
  const profile = CULTURAL_PROFILES[profileKey] || CULTURAL_PROFILES['en-US'];

  let greetingLine = '';
  if (profile.greeting_phrases && profile.greeting_phrases.length > 0) {
    const greeting = profile.greeting_phrases[0].replace('[Business]', businessName || 'our business');
    greetingLine = `\nPreferred greeting: ${greeting}`;
  }

  return `
CULTURAL COMMUNICATION PROFILE: ${profile.name}
Formality level: ${profile.formality}
Communication pace: ${profile.communication_pace || 'moderate'}
Directness: ${profile.directness || 'moderate'}

Cultural style notes:
${profile.style_notes}
${greetingLine}

IMPORTANT: Adapt your entire communication style to match these cultural expectations. This caller will have significantly better experience when you communicate in a culturally appropriate way.
`;
}

export function getProfileCount(): number {
  return Object.keys(CULTURAL_PROFILES).length;
}

export function getLanguageCount(): number {
  const langs = new Set(Object.keys(CULTURAL_PROFILES).map(k => k.split('-')[0]));
  return langs.size;
}

export function getAllProfileNames(): Array<{ code: string; name: string }> {
  return Object.entries(CULTURAL_PROFILES).map(([code, p]) => ({ code, name: p.name }));
}
