/**
 * Bundled symptom triage database for the `check_symptoms` tool.
 *
 * Deliberately small, conservative, and offline — the whole point of this tool
 * is to be deterministic and free of network failure modes. The model gets a
 * structured urgency cue + general guidance bullets; the system prompt forbids
 * it from turning that into a diagnosis.
 *
 * Matching is plain substring on lowercased joined input. We accept a list of
 * strings rather than a single blob because the user-facing tool input takes
 * an array of symptom phrases.
 */

export type Urgency = "low" | "medium" | "high" | "emergency";

export interface SymptomEntry {
  keywords: string[];
  urgency: Urgency;
  guidance: string;
}

export const SYMPTOM_DB: SymptomEntry[] = [
  {
    keywords: ["chest pain", "pain in chest", "tight chest", "chest pressure"],
    urgency: "emergency",
    guidance:
      "Chest pain can indicate a cardiac emergency. Call emergency services (e.g. 911 in the US) immediately, especially if accompanied by shortness of breath, sweating, nausea, or pain radiating to the arm or jaw.",
  },
  {
    keywords: [
      "shortness of breath",
      "short of breath",
      "trouble breathing",
      "can't breathe",
      "difficulty breathing",
    ],
    urgency: "emergency",
    guidance:
      "Sudden or severe shortness of breath is a medical emergency. Call emergency services and stay calm; sit upright while waiting for help.",
  },
  {
    keywords: ["severe headache", "worst headache", "thunderclap headache"],
    urgency: "high",
    guidance:
      "A sudden, severe headache (worst of your life) can signal a serious neurological event. Seek urgent medical evaluation today.",
  },
  {
    keywords: ["fever", "high temperature", "running a fever"],
    urgency: "medium",
    guidance:
      "Track temperature and hydration. See a clinician promptly if fever exceeds 39.4°C / 103°F, lasts more than 3 days, or is accompanied by stiff neck, rash, or confusion.",
  },
  {
    keywords: ["nausea", "vomiting", "throwing up"],
    urgency: "medium",
    guidance:
      "Sip clear fluids in small amounts. Seek care if vomiting persists more than 24 hours, contains blood, or is accompanied by severe abdominal pain or signs of dehydration.",
  },
  {
    keywords: ["headache", "head ache", "head pain"],
    urgency: "low",
    guidance:
      "Common headaches often respond to rest, hydration, and over-the-counter pain relief. Talk to a clinician if they are frequent, worsening, or unusual for you.",
  },
  {
    keywords: ["sore throat", "throat pain", "scratchy throat"],
    urgency: "low",
    guidance:
      "Warm fluids, throat lozenges, and rest typically help. See a clinician if it lasts more than a week, includes high fever, or causes trouble swallowing or breathing.",
  },
  {
    keywords: ["cough", "coughing"],
    urgency: "low",
    guidance:
      "Hydration and rest are first-line. See a clinician for cough lasting more than 3 weeks, with blood, or with high fever or shortness of breath.",
  },
];

const URGENCY_RANK: Record<Urgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  emergency: 3,
};

const URGENCY_BY_RANK: Urgency[] = ["low", "medium", "high", "emergency"];

export interface SymptomMatch {
  matched: string[];
  urgency: Urgency | "none";
  bullets: string[];
}

export function matchSymptoms(input: string[]): SymptomMatch {
  const joined = (input ?? [])
    .filter((s) => typeof s === "string")
    .join(" \n ")
    .toLowerCase();

  if (joined.trim().length === 0) {
    return { matched: [], urgency: "none", bullets: [] };
  }

  const matched: string[] = [];
  const bullets: string[] = [];
  let topRank = -1;

  for (const entry of SYMPTOM_DB) {
    const hit = entry.keywords.find((k) => joined.includes(k));
    if (!hit) continue;
    matched.push(hit);
    bullets.push(entry.guidance);
    const rank = URGENCY_RANK[entry.urgency];
    if (rank > topRank) topRank = rank;
  }

  return {
    matched,
    urgency: topRank === -1 ? "none" : URGENCY_BY_RANK[topRank]!,
    bullets,
  };
}
