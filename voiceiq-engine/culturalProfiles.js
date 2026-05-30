export const CULTURAL_PROFILES = {
  'es-MX': {
    name: 'Mexican Spanish',
    formality: 'warm_informal',
    communication_pace: 'moderate',
    directness: 'low',
    greeting_phrases: ['¡Buenos días! ¿Cómo le puedo ayudar hoy?'],
    style_notes: 'Use warm, familial tone. Address as "usted" initially but follow their lead. Build rapport before business. Use "por favor" and "con mucho gusto" frequently. Be patient — rushing feels rude.'
  },
  'es-CO': {
    name: 'Colombian Spanish',
    formality: 'formal_warm',
    communication_pace: 'moderate',
    directness: 'moderate',
    greeting_phrases: ['¡Buenos días! ¿Con quién tengo el gusto?'],
    style_notes: 'More formal than Mexican Spanish. Always use "usted". "Colaborar" instead of "ayudar" is preferred. Bogotanos are very formal and professional.'
  },
  'es-US': {
    name: 'US Hispanic Spanish',
    formality: 'casual_bilingual',
    communication_pace: 'fast',
    directness: 'moderate_high',
    style_notes: 'Many US Hispanic callers code-switch between English and Spanish. Be ready to respond in whichever language they use most. More direct than Latin American Spanish.'
  },
  'ar-EG': {
    name: 'Egyptian Arabic',
    formality: 'warm_moderate',
    communication_pace: 'expressive',
    directness: 'indirect',
    style_notes: 'Egyptians are warm and expressive communicators. Religious greetings (As-salamu alaykum) are appropriate. Build personal rapport first — business is secondary.'
  },
  'ar-SA': {
    name: 'Gulf/Saudi Arabic',
    formality: 'formal_respectful',
    communication_pace: 'deliberate',
    directness: 'indirect',
    style_notes: 'Very formal register required initially. Religious greetings mandatory. Title and respect extremely important. Allow time for pleasantries — never rush.'
  },
  'ar-MA': {
    name: 'Moroccan Arabic (Darija)',
    formality: 'casual_warm',
    communication_pace: 'fast',
    style_notes: 'Moroccan Darija is very different from Modern Standard Arabic. Many Moroccans prefer French for formal matters. Offer to switch to French if needed.'
  },
  'fr-FR': {
    name: 'Metropolitan French',
    formality: 'formal',
    communication_pace: 'measured',
    directness: 'moderate',
    greeting_phrases: ['Bonjour, comment puis-je vous aider?'],
    style_notes: 'French callers expect professional, precise language. Use "vous" always. Avoid excessive enthusiasm — it seems insincere. Be direct and logical.'
  },
  'fr-CA': {
    name: 'Canadian French (Québécois)',
    formality: 'casual_warm',
    style_notes: 'More casual than European French. "Tu" is acceptable earlier in conversation. Warmer and more American-influenced in style.'
  },
  'fr-CI': {
    name: "West African French",
    formality: 'warm_respectful',
    style_notes: 'West African French is warm and relationship-oriented. Greetings are very important. Respect for elders and authority is paramount.'
  },
  'pt-BR': {
    name: 'Brazilian Portuguese',
    formality: 'casual_warm',
    communication_pace: 'fast_expressive',
    directness: 'moderate',
    greeting_phrases: ['Olá! Tudo bem? Como posso te ajudar?'],
    style_notes: 'Brazilians are very warm and expressive. Enthusiasm and positivity are welcome. Very different from European Portuguese.'
  },
  'pt-PT': {
    name: 'European Portuguese',
    formality: 'formal_reserved',
    style_notes: 'More formal and reserved than Brazilian Portuguese. Use "o senhor/a senhora" for formal address. Direct but polite.'
  },
  'zh-CN': {
    name: 'Mandarin (Simplified/Mainland)',
    formality: 'respectful_formal',
    communication_pace: 'measured',
    directness: 'indirect',
    style_notes: 'Respect and hierarchy are fundamental. Avoid causing "face loss". Frame negatives indirectly. Be patient.'
  },
  'zh-TW': {
    name: 'Mandarin (Traditional/Taiwan)',
    formality: 'polite_warm',
    style_notes: 'Similar to mainland but slightly warmer. Very polite and service-oriented expectations.'
  },
  'hi-IN': {
    name: 'Hindi (India)',
    formality: 'respectful',
    style_notes: 'Use "Aap" (formal you) not "tum". Respect for education and professional status. English mix (Hinglish) is common — follow their lead.'
  },
  'ko-KR': {
    name: 'Korean',
    formality: 'hierarchical_formal',
    style_notes: 'Formal speech levels are critical. Use formal speech always initially. Punctuality and efficiency are valued.'
  },
  'en-US': {
    name: 'American English',
    formality: 'casual_professional',
    communication_pace: 'moderate_fast',
    directness: 'high',
    style_notes: 'Friendly but efficient. Get to the point. First names are fine. Positivity and can-do attitude expected.'
  }
};

export function detectCulturalProfile(language, transcript, callerPhone) {
  const lower = (transcript || '').toLowerCase();

  if (language.startsWith('es')) {
    if (lower.includes('colaborar') || lower.includes('parcero')) return 'es-CO';
    if (lower.includes('wey') || lower.includes('güey') || lower.includes('órale')) return 'es-MX';
    return 'es-US';
  }
  if (language.startsWith('ar')) {
    if (lower.includes('إزيك') || transcript.includes('إزيك')) return 'ar-EG';
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

export function buildCulturalPrompt(language, transcript, callerPhone, businessName) {
  const profileKey = detectCulturalProfile(language, transcript, callerPhone);
  const profile = CULTURAL_PROFILES[profileKey] || CULTURAL_PROFILES['en-US'];

  let greetingLine = '';
  if (profile.greeting_phrases && profile.greeting_phrases.length > 0) {
    const greeting = profile.greeting_phrases[0].replace('[Business]', businessName || 'our business');
    greetingLine = `\nPreferred greeting: ${greeting}`;
  }

  return {
    profileKey,
    profileName: profile.name,
    prompt: `
CULTURAL COMMUNICATION PROFILE: ${profile.name}
Formality level: ${profile.formality}
Communication pace: ${profile.communication_pace || 'moderate'}
Directness: ${profile.directness || 'moderate'}

Cultural style notes:
${profile.style_notes}
${greetingLine}

IMPORTANT: Adapt your entire communication style to match these cultural expectations. This caller will have significantly better experience when you communicate in a culturally appropriate way.
`
  };
}
