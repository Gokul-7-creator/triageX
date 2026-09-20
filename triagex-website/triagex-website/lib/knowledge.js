/* =====================================================================
   KNOWLEDGE BASE — AI Case Assistant (RAG source material)
   =====================================================================
   IMPORTANT: this is a small, hand-written set of GENERIC triage
   reference notes for this project only. It is NOT an official or
   institution-approved clinical protocol, NOT sourced from a real
   guideline document, and NOT medical advice. It exists purely to give
   the "AI Case Assistant" feature something concrete to retrieve and
   ground its answers in. Every place this content reaches the UI, it is
   labeled as illustrative reference material — never presented as a
   real hospital protocol.
   ===================================================================== */

export const KNOWLEDGE_DISCLAIMER =
  'Reference notes below are a small illustrative set written for this project, not an approved clinical protocol. AI output is decision support only — it does not diagnose and does not replace clinical judgment.';

/** Each chunk: id, short title, freeform text. An OpenAI embedding is
 * computed for "title. text" once at server startup and cached in
 * memory — real vector retrieval, not keyword matching. */
export const KNOWLEDGE_BASE = [
  {
    id: 'chest-pain',
    title: 'Chest pain — general watch points',
    text: 'Chest pain paired with a cardiac history, radiating pain, sweating, or breathlessness is generally treated as higher concern in triage protocols, since it overlaps with presentations of acute coronary syndrome. Reported severity and duration both matter — sudden severe onset is weighted more than a dull ache present for days.',
  },
  {
    id: 'breathing-difficulty',
    title: 'Breathing difficulty & SpO2',
    text: 'Breathing difficulty combined with a falling SpO2 (below ~90-92%) or a fast respiratory rate is a common escalation trigger in triage systems, since oxygenation can deteriorate quickly. A history of asthma raises the index of suspicion for rapid decline even when initial vitals look only mildly abnormal.',
  },
  {
    id: 'fever-sepsis',
    title: 'Fever with other deranged vitals',
    text: 'A high fever on its own is usually not urgent by itself, but fever alongside a fast heart rate, low blood pressure, or confusion/weakness is a classic pattern flagged for possible sepsis in many triage frameworks — the combination matters more than any single reading.',
  },
  {
    id: 'severe-headache',
    title: 'Severe headache — red flags',
    text: 'A headache described as the worst of the patient’s life, sudden in onset, or accompanied by loss of consciousness, seizure, or neurological symptoms is typically treated as higher concern than a gradual, familiar headache pattern (e.g. known migraine).',
  },
  {
    id: 'abdominal-pain',
    title: 'Abdominal pain',
    text: 'Severe abdominal pain with vomiting, guarding, or signs of bleeding is generally escalated faster than mild, intermittent discomfort. In older patients or those with a surgical history, even moderate abdominal pain is sometimes weighted more heavily due to a wider range of possible causes.',
  },
  {
    id: 'bleeding',
    title: 'Bleeding',
    text: 'Active or heavy bleeding is weighted heavily in most triage scales because of the risk of rapid deterioration; a falling systolic blood pressure alongside reported bleeding is treated as a stronger combined signal than either finding alone.',
  },
  {
    id: 'seizure-loc',
    title: 'Seizure & loss of consciousness',
    text: 'A witnessed seizure or any loss of consciousness is generally treated as an immediate-attention finding in triage systems, independent of how the patient presents afterward, since the underlying cause (cardiac, neurological, metabolic) cannot be determined at check-in.',
  },
  {
    id: 'vitals-thresholds',
    title: 'Common vital-sign thresholds used in triage scoring',
    text: 'Commonly referenced rough thresholds: SpO2 under ~90% is a strong red flag, 90-94% is a moderate concern. Heart rate under ~40 or over ~130 bpm is notable. Systolic BP under ~85 or over ~180 mmHg is notable. Respiratory rate under ~9 or over ~28 breaths/min is notable. Temperature under 35°C or over ~39.5°C is notable. These are illustrative rules of thumb for this project, not a validated clinical scale.',
  },
  {
    id: 'history-modifiers',
    title: 'How medical history typically modifies urgency',
    text: 'Pre-existing conditions rarely raise urgency on their own, but they change how much weight a new symptom gets: e.g. chest pain in a patient with a cardiac history, breathing difficulty in a patient with asthma, or fever in a patient on immunosuppressive medication is typically treated more cautiously than the same symptom in a patient without that history.',
  },
  {
    id: 'age-factor',
    title: 'Age as a modifying factor',
    text: 'Very young children and older adults are generally triaged with a lower threshold for escalation, because the same symptom (e.g. fever, dizziness, mild dehydration) can progress faster or present more subtly in those age groups than in a healthy working-age adult.',
  },
  {
    id: 'mild-single-symptom',
    title: 'Isolated mild symptoms',
    text: 'A single mild symptom with no history, normal vitals, and no red-flag combination is generally routed as routine/normal priority — most triage systems reserve urgent and critical tiers for combinations of findings or clearly severe single findings, to avoid over-triaging low-risk patients.',
  },
  {
    id: 'reassessment-principle',
    title: 'Why reassessment matters',
    text: 'Triage priority reflects a snapshot at check-in, not a guarantee — patients can deteriorate while waiting. Most triage protocols call for periodic reassessment, and any patient reporting worsening symptoms while waiting is generally reassessed immediately rather than waiting for a scheduled recheck.',
  },
  {
    id: 'disclaimer-scope',
    title: 'What this AI assistant is and is not',
    text: 'This assistant summarizes and explains the case data already entered and the priority already computed by the rule-based triage engine, grounded in the short reference notes in this knowledge base. It does not diagnose a disease, does not recommend treatment, and does not replace a clinician’s judgment or an institution’s actual protocols.',
  },
];

export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Pick the topK knowledge chunks whose cached embedding is closest to
 * queryEmbedding. `embeddedChunks` is [{ ...chunk, embedding: number[] }]. */
export function retrieveTopChunks(embeddedChunks, queryEmbedding, topK = 5) {
  return embeddedChunks
    .map(c => ({ chunk: c, score: cosineSimilarity(c.embedding, queryEmbedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.chunk);
}
