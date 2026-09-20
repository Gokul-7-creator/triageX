import { SYMPTOMS, HISTORY_ITEMS } from './i18n.js';
import { flagVital, VITAL_RANGES, MODEL_VERSION } from './triage.js';

const VITAL_LABELS = { temperature: 'Temperature', heartRate: 'Heart Rate', systolicBp: 'Systolic BP', diastolicBp: 'Diastolic BP', spo2: 'SpO₂', respiratoryRate: 'Resp. Rate' };

function labelFor(list, code) {
  const found = list.find(x => x.code === code);
  return found ? found.en : code;
}

/** Build the compact, factual case summary text sent to the model — the
 * same data the UI already shows, nothing extra. `c` is the case object
 * the frontend posts: { age, gender, symptoms, vitals, history, triage }. */
export function buildCaseContextText(c) {
  const symptomLines = (c.symptoms || []).map(s => `- ${labelFor(SYMPTOMS, s.code)} (${s.severity})`).join('\n') || 'None recorded';
  const vitalLines = Object.entries(c.vitals || {}).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `- ${VITAL_LABELS[k] || k}: ${v}${VITAL_RANGES[k]?.unit || ''}${flagVital(k, v) ? ` (flagged: ${flagVital(k, v)})` : ''}`).join('\n') || 'None recorded';
  const historyLines = (c.history || []).map(h => labelFor(HISTORY_ITEMS, h)).join(', ') || 'None recorded';
  const factorLines = (c.triage?.factors || []).map(f => `- ${f.label} (weight +${f.weight})`).join('\n') || 'None';

  return `Patient case (demo data, not a real patient):
Age: ${c.age}, Gender: ${c.gender}
Symptoms:
${symptomLines}
Vitals:
${vitalLines}
Medical history: ${historyLines}
Computed triage priority: ${c.triage?.priority} (risk score ${c.triage?.riskScore}/100, model ${c.triage?.modelVersion || MODEL_VERSION})
Contributing factors the triage engine identified:
${factorLines}`;
}

/** Compact text used to embed the case for retrieval — just the parts
 * that matter for picking relevant reference notes. */
export function buildCaseRetrievalText(c, question) {
  const symptomText = (c.symptoms || []).map(s => labelFor(SYMPTOMS, s.code)).join(', ');
  const historyText = (c.history || []).map(h => labelFor(HISTORY_ITEMS, h)).join(', ');
  const vitalFlagText = Object.entries(c.vitals || {})
    .filter(([k, v]) => v != null && v !== '' && flagVital(k, v) && flagVital(k, v) !== 'normal')
    .map(([k]) => VITAL_LABELS[k] || k).join(', ');
  return [symptomText, historyText, vitalFlagText, question || ''].filter(Boolean).join('. ');
}

export const AI_SYSTEM_RULES = `You are a decision-support assistant embedded in TRIAGE-X, a hospital triage prototype. You help clinical staff quickly understand a case and the priority already computed by the app's own triage engine (a rules-based model, not you).
Hard rules:
- You do NOT diagnose a disease and you do NOT recommend a specific treatment or medication.
- You explain, in plain language, why the case data plausibly supports (or is in tension with) the computed priority, grounded in the short reference notes provided below.
- If asked something outside this case's data and the reference notes, say you don't have that information rather than guessing.
- Keep answers concise (a few short paragraphs or bullet points), written for a nurse or doctor who is busy.
- Never state or imply that your explanation is itself a diagnosis or a directive to act.`;

export function buildReferenceNotesText(chunks) {
  return chunks.map(c => `[${c.id}] ${c.title}: ${c.text}`).join('\n\n');
}
