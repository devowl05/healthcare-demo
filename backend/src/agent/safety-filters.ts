/**
 * Crisis-keyword detection and resource directives.
 *
 * Triggered terms get a small system-message prepended to the model's context
 * so the reply *always* leads with safe-routing language — even if the model
 * forgets the rule from the main system prompt. Kept here so safety messaging
 * has exactly one source of truth across crisis flows.
 *
 * Word list is intentionally narrow. False-positive control: we match on
 * specific phrases (e.g. `kill myself`) rather than bare words like `dying`,
 * which would catch "dying of laughter" and many other innocent phrases.
 */

const CRISIS_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\bsuicide\b/i, category: "suicide" },
  { pattern: /\bkill\s+myself\b/i, category: "self_harm" },
  { pattern: /\bend\s+my\s+life\b/i, category: "self_harm" },
  { pattern: /\bhurt\s+myself\b/i, category: "self_harm" },
  { pattern: /\boverdose\b/i, category: "overdose" },
];

export interface CrisisDetection {
  triggered: boolean;
  categories: string[];
}

export function detectCrisis(text: string): CrisisDetection {
  if (typeof text !== "string" || text.length === 0) {
    return { triggered: false, categories: [] };
  }
  const hits = new Set<string>();
  for (const { pattern, category } of CRISIS_PATTERNS) {
    if (pattern.test(text)) hits.add(category);
  }
  const categories = Array.from(hits);
  return { triggered: categories.length > 0, categories };
}

/**
 * Centralized crisis-resource text. Returned as a system-message block to be
 * prepended to the conversation when `detectCrisis().triggered` is true.
 */
export function crisisPrependSystemMessage(): string {
  return [
    "CRISIS_RESOURCES: This user may be in distress. Begin your reply by sharing crisis resources:",
    "- In the US: call or text 988 (Suicide & Crisis Lifeline).",
    "- Elsewhere: call your local emergency number or a trusted suicide-prevention hotline.",
    "Encourage the user to reach out to a qualified clinician or emergency services. Do not provide methods of self-harm under any circumstances.",
  ].join("\n");
}
