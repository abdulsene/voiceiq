const EMOTION_SIGNALS = {
  frustrated: {
    keywords: [
      'this is ridiculous', 'unacceptable', 'terrible',
      'awful', 'horrible', 'worst', 'useless', 'pathetic',
      'frustrated', 'fed up', 'sick of', 'tired of',
      'never again', 'waste of time', 'incompetent',
      'furious', 'angry', 'outraged', 'disgusted',
      'not happy', 'very upset', 'extremely upset'
    ],
    toneAdjustment: 'slower, more empathetic, apologetic',
    responsePrefix: [
      "I completely understand your frustration, and I sincerely apologize.",
      "I hear you, and I'm truly sorry you're experiencing this.",
      "Your frustration is completely valid, and I want to make this right."
    ],
    immediateTransfer: false
  },
  excited: {
    keywords: [
      'amazing', 'perfect', 'exactly what', 'love it',
      'fantastic', 'wonderful', 'great news', 'excited',
      "can't wait", 'this is great', 'awesome',
      'absolutely', 'definitely', 'yes please',
      'sounds perfect', 'that works great'
    ],
    toneAdjustment: 'enthusiastic, match their energy, move faster',
    responsePrefix: [
      "That's wonderful to hear!",
      "Excellent!",
      "Perfect!"
    ],
    immediateTransfer: false
  },
  confused: {
    keywords: [
      "I don't understand", 'what do you mean',
      'can you explain', "I'm confused", 'not sure',
      'what is that', 'how does that work',
      "I don't know", 'unclear', 'lost',
      'what exactly', 'could you clarify',
      'repeat that', 'say that again', 'sorry what'
    ],
    toneAdjustment: 'slower, simpler language, more explanatory',
    responsePrefix: [
      "Of course, let me explain that more clearly.",
      "Great question — let me break that down simply.",
      "Absolutely, let me walk you through that step by step."
    ],
    immediateTransfer: false
  },
  distressed: {
    keywords: [
      'emergency', 'help me', "I'm scared",
      'in pain', 'hurts', 'bleeding', 'accident',
      'please help', 'desperate', 'crying',
      "don't know what to do", 'overwhelmed',
      'anxiety', 'panic', 'terrified', 'devastated',
      'just lost', 'passed away', 'died'
    ],
    toneAdjustment: 'very warm, slow, calm, offer immediate human transfer',
    responsePrefix: [
      "I'm so sorry you're going through this.",
      "I hear you and I'm here to help right now.",
      "Take a breath — I'm going to help you through this."
    ],
    immediateTransfer: true
  },
  rushed: {
    keywords: [
      'quick question', 'in a hurry', "don't have time",
      'make it fast', 'quickly', 'short on time',
      'running late', 'just need to know',
      'simple question', 'fast', 'brief',
      'got to go', 'busy right now'
    ],
    toneAdjustment: 'concise, efficient, get to the point fast',
    responsePrefix: [
      "Absolutely, I'll be quick.",
      "Of course — right to the point.",
      "Got it — here's the short answer:"
    ],
    immediateTransfer: false
  },
  satisfied: {
    keywords: [
      'thank you so much', 'really helpful',
      "you've been great", 'excellent service',
      'very pleased', "couldn't be happier",
      'perfect thank you', "that's all I needed",
      'great job', 'very professional'
    ],
    toneAdjustment: 'warm, appreciative, reinforce positive feeling',
    responsePrefix: [
      "It's been my pleasure!",
      "So glad I could help!",
      "Wonderful — that's exactly what we love to hear!"
    ],
    immediateTransfer: false
  }
};

const EMOTION_SCORE_MAP = {
  frustrated: -20,
  distressed: -20,
  confused: -5,
  rushed: -5,
  neutral: 0,
  excited: 20,
  satisfied: 20,
};

export function detectEmotion(transcript) {
  const lower = (transcript || '').toLowerCase();
  let highestScore = 0;
  let detectedEmotion = 'neutral';
  let triggers = [];

  for (const [emotion, signals] of Object.entries(EMOTION_SIGNALS)) {
    const matches = signals.keywords.filter(kw => lower.includes(kw.toLowerCase()));
    const score = matches.length / signals.keywords.length;

    if (matches.length > 0 && score > highestScore) {
      highestScore = score;
      detectedEmotion = emotion;
      triggers = matches;
    }
  }

  return {
    emotion: detectedEmotion,
    confidence: Math.min(1, highestScore * 3),
    triggers,
  };
}

export function getEmotionSignals(emotion) {
  return EMOTION_SIGNALS[emotion] || null;
}

export function shouldAutoTransfer(emotion) {
  const signals = EMOTION_SIGNALS[emotion];
  return signals?.immediateTransfer === true;
}

export function getEmotionAdjustedPrompt(emotion, basePrompt) {
  if (emotion === 'neutral') return basePrompt;

  const signals = EMOTION_SIGNALS[emotion];
  if (!signals) return basePrompt;

  const prefix = signals.responsePrefix[Math.floor(Math.random() * signals.responsePrefix.length)];

  const emotionInstruction = `
CURRENT CALLER EMOTIONAL STATE: ${emotion.toUpperCase()}
Tone adjustment required: ${signals.toneAdjustment}
Suggested response opening: "${prefix}"
${signals.immediateTransfer ? 'PRIORITY: Offer immediate transfer to human staff. The caller appears to be in distress.' : ''}
`;

  return basePrompt + '\n\n' + emotionInstruction;
}

export function calculateSentimentScore(emotionHistory) {
  if (!emotionHistory || emotionHistory.length === 0) return 50;

  let adjustment = 0;
  for (const entry of emotionHistory) {
    adjustment += EMOTION_SCORE_MAP[entry.emotion] || 0;
  }

  return Math.max(0, Math.min(100, 50 + adjustment));
}

export function getDominantEmotion(emotionHistory) {
  if (!emotionHistory || emotionHistory.length === 0) return 'neutral';

  const counts = {};
  for (const entry of emotionHistory) {
    counts[entry.emotion] = (counts[entry.emotion] || 0) + 1;
  }

  let dominant = 'neutral';
  let maxCount = 0;
  for (const [emotion, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      dominant = emotion;
    }
  }
  return dominant;
}
