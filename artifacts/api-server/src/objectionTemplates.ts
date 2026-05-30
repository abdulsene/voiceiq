export const OBJECTION_TEMPLATES: Record<string, Array<{
  objection_phrase: string;
  objection_category: string;
  ai_response: string;
  follow_up_action: string;
}>> = {
  dental: [
    {
      objection_phrase: "too expensive, can't afford",
      objection_category: "price",
      ai_response: "I completely understand. We actually have several options that might help — we offer an in-house membership plan starting at just $29/month that covers your cleanings and gives you 20% off all other treatments. Would you like me to tell you more about it?",
      follow_up_action: "offer_payment_plan"
    },
    {
      objection_phrase: "no insurance, don't have insurance",
      objection_category: "insurance",
      ai_response: "No insurance is absolutely fine — many of our patients are in the same situation. We have an in-house savings plan that's actually better than most insurance plans for people who come in regularly. It covers your exams and cleanings with no annual limits or waiting periods.",
      follow_up_action: "explain_membership"
    },
    {
      objection_phrase: "scared, afraid, dental anxiety, nervous",
      objection_category: "anxiety",
      ai_response: "That's actually one of the most common things we hear, and I want you to know our team is specifically trained for patients with dental anxiety. We go at your pace, explain everything before we do it, and sedation options are available if needed. Many of our most anxious patients say their first visit was nothing like they expected.",
      follow_up_action: "schedule_consultation"
    },
    {
      objection_phrase: "need to think about it, call you back",
      objection_category: "delay",
      ai_response: "Of course, take all the time you need. Can I ask — is there anything specific you're weighing? Sometimes I can answer a question right now that makes the decision easier. And if you'd like, I can hold a spot tentatively so you have the option without any commitment.",
      follow_up_action: "hold_appointment"
    },
    {
      objection_phrase: "I have a dentist already, current dentist",
      objection_category: "loyalty",
      ai_response: "That's great that you have a relationship with a dentist. Many people come to us for a second opinion or because their schedule works better with ours. We offer evening and weekend appointments that a lot of practices don't. Would it help to come in just for a consultation to see if we might be a good fit?",
      follow_up_action: "offer_consultation"
    }
  ],
  legal: [
    {
      objection_phrase: "too expensive, can't afford attorney",
      objection_category: "price",
      ai_response: "I understand cost is a real concern. Our attorneys offer free initial consultations so you can understand your options before any commitment. For many case types, we work on contingency — meaning we only get paid if you win. There's no upfront cost at all.",
      follow_up_action: "schedule_free_consult"
    },
    {
      objection_phrase: "not sure I have a case",
      objection_category: "qualification",
      ai_response: "That's exactly what the free consultation is for. Many people don't know if they have a case until they speak with an attorney. Our team can review what happened and give you an honest assessment — completely free and with no obligation. The call takes about 15 minutes.",
      follow_up_action: "schedule_free_consult"
    },
    {
      objection_phrase: "already have a lawyer, have an attorney",
      objection_category: "loyalty",
      ai_response: "That's completely fine. Many people come to us for a second opinion, especially in cases involving significant compensation. A fresh perspective is always valuable and our consultation is free.",
      follow_up_action: "offer_second_opinion"
    }
  ],
  hvac: [
    {
      objection_phrase: "too expensive, get another quote",
      objection_category: "price",
      ai_response: "Absolutely, getting multiple quotes is smart. I will say — our pricing includes a 2-year labor warranty and 10-year parts warranty that most companies don't offer. When you compare, make sure you're comparing the full package. Can I schedule the estimate so you have our number to compare against?",
      follow_up_action: "schedule_estimate"
    },
    {
      objection_phrase: "not urgent, can wait",
      objection_category: "urgency",
      ai_response: "Totally understand. Just want to mention that small issues tend to compound — a minor refrigerant leak in summer can become a full compressor replacement by August. We can do a quick diagnostic for free so you know exactly what you're dealing with before deciding.",
      follow_up_action: "offer_free_diagnostic"
    }
  ],
  medical: [
    {
      objection_phrase: "no insurance, don't have coverage",
      objection_category: "insurance",
      ai_response: "We see patients with and without insurance. We offer a sliding scale fee based on income and have a self-pay discount program. I can have someone from our billing team call you to walk through exactly what your visit would cost — no surprises.",
      follow_up_action: "connect_billing"
    },
    {
      objection_phrase: "not accepting new patients",
      objection_category: "availability",
      ai_response: "We do have limited availability for new patients right now. Let me check — we actually have an opening next week. Would you like me to hold that spot? New patient openings fill up quickly.",
      follow_up_action: "book_new_patient"
    }
  ],
  restaurant: [
    {
      objection_phrase: "too expensive, pricey",
      objection_category: "price",
      ai_response: "I understand. We do have a prix fixe menu on Tuesday and Wednesday evenings that's exceptional value — three courses for $45 per person. Many guests say it's their favorite way to experience the kitchen. Would that evening work for you?",
      follow_up_action: "offer_prix_fixe"
    },
    {
      objection_phrase: "dietary restrictions, allergies, vegan, gluten",
      objection_category: "dietary",
      ai_response: "Our kitchen is very accommodating. Our chef works with dietary restrictions and allergies every night. If you let me note yours now, I'll make sure the kitchen is prepared before you arrive. What should I add to your reservation?",
      follow_up_action: "note_dietary"
    }
  ],
  plumbing: [
    {
      objection_phrase: "too expensive, get another quote",
      objection_category: "price",
      ai_response: "Absolutely, getting multiple quotes is smart. Our pricing includes a full warranty on parts and labor, and we don't charge for the diagnostic if you go with our service. Can I schedule a free estimate so you have our number to compare?",
      follow_up_action: "schedule_estimate"
    },
    {
      objection_phrase: "not urgent, can wait",
      objection_category: "urgency",
      ai_response: "I understand. Just want to mention that small leaks can lead to water damage and mold if left too long. We can do a quick inspection for free to make sure nothing is getting worse. Would that give you peace of mind?",
      follow_up_action: "offer_free_inspection"
    }
  ],
  real_estate: [
    {
      objection_phrase: "just looking, not ready",
      objection_category: "delay",
      ai_response: "That's totally fine — most people start by looking. We can set you up with a free home search that sends you listings matching your criteria, so when you are ready, you'll know exactly what's out there. No pressure at all.",
      follow_up_action: "setup_home_search"
    },
    {
      objection_phrase: "already have an agent",
      objection_category: "loyalty",
      ai_response: "That's great. If you ever want a second opinion on a property or want to compare approaches, we're happy to help. Many of our clients came to us after working with another agent.",
      follow_up_action: "offer_consultation"
    }
  ],
  beauty: [
    {
      objection_phrase: "too expensive, pricey",
      objection_category: "price",
      ai_response: "I understand. We do offer a first-visit discount of 20% off any service, and our loyalty program gives you a free service after every 10 visits. Would you like to take advantage of the new client special?",
      follow_up_action: "offer_discount"
    }
  ],
  automotive: [
    {
      objection_phrase: "too expensive, cheaper elsewhere",
      objection_category: "price",
      ai_response: "I understand price is important. We price-match any written estimate from a certified dealer, and our service comes with a comprehensive warranty. Would you like to bring in your estimate so we can see if we can match or beat it?",
      follow_up_action: "price_match"
    }
  ],
  general: [
    {
      objection_phrase: "too expensive, can't afford",
      objection_category: "price",
      ai_response: "I understand budget is important. We have flexible options and would love to find something that works for you. Can I explain our different packages so we can find the best fit?",
      follow_up_action: "explain_options"
    },
    {
      objection_phrase: "need to think about it, call you back",
      objection_category: "delay",
      ai_response: "Of course, take your time. Is there anything specific I can clarify right now that might help with your decision? I'm happy to answer any questions.",
      follow_up_action: "hold_appointment"
    }
  ]
};
