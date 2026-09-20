// TRIAGE-X — triage_engine.js (browser port)
//
// PROTOTYPE NOTICE
// -----------------
// The production design for TRIAGE-X calls for a Python service
// (ml/train.py → model.pkl, served by FastAPI's triage_engine.py) that
// trains an interpretable Random Forest on historical triage data. A
// published Artifact page cannot run a Python process or host a trained
// binary model, so this file is a deterministic, fully transparent
// weighted rule-engine that stands in for it. It consumes exactly the
// same feature set the spec calls for (age, gender, symptoms + severity,
// vitals, history) and produces the same output contract (priority,
// 0-100 risk score, ranked contributing factors), so the rest of the
// application — queue ordering, explainability panel, reassessment flow —
// is exercised for real. It is NOT a trained clinical model and every
// screen that surfaces its output says so.

export const MODEL_VERSION = 'TX-Heuristic-v1.0 (prototype, not clinically validated)';

export const VITAL_RANGES = {
  temperature: { unit: '°C', min: 30, max: 43, normal: [36.1, 37.8], abnormal: [35, 39.4], step: 0.1 },
  heartRate:   { unit: 'bpm', min: 20, max: 220, normal: [60, 100], abnormal: [40, 130], step: 1 },
  systolicBp:  { unit: 'mmHg', min: 40, max: 260, normal: [90, 130], abnormal: [80, 180], step: 1 },
  diastolicBp: { unit: 'mmHg', min: 20, max: 160, normal: [60, 85], abnormal: [50, 100], step: 1 },
  spo2:        { unit: '%', min: 40, max: 100, normal: [95, 100], abnormal: [90, 100], step: 1 },
  respiratoryRate: { unit: 'br/min', min: 4, max: 60, normal: [12, 20], abnormal: [8, 30], step: 1 },
};

/** Classifies one vital reading as normal / abnormal / critical against
 *  adult reference ranges. This is a visual-flagging aid only — see the
 *  disclaimers throughout the app. */
export function flagVital(key, value) {
  const r = VITAL_RANGES[key];
  if (value == null || value === '' || isNaN(value) || !r) return null;
  const v = Number(value);
  if (v >= r.normal[0] && v <= r.normal[1]) return 'normal';
  if (v >= r.abnormal[0] && v <= r.abnormal[1]) return 'abnormal';
  return 'critical';
}

const SYMPTOM_WEIGHTS = {
  chest_pain:           { mild: 10, moderate: 17, severe: 27 },
  breathing_difficulty: { mild: 10, moderate: 17, severe: 27 },
  seizure:              { mild: 26, moderate: 30, severe: 34 },
  unconsciousness:      { mild: 30, moderate: 34, severe: 38 },
  bleeding:              { mild: 6, moderate: 13, severe: 22 },
  severe_headache:       { mild: 4, moderate: 8,  severe: 13 },
  dizziness:             { mild: 3, moderate: 6,  severe: 10 },
  abdominal_pain:        { mild: 3, moderate: 7,  severe: 11 },
  vomiting:              { mild: 2, moderate: 5,  severe: 9 },
  weakness:              { mild: 2, moderate: 5,  severe: 8 },
  fever:                 { mild: 2, moderate: 5,  severe: 9 },
  cough:                 { mild: 1, moderate: 3,  severe: 6 },
  other:                 { mild: 2, moderate: 4,  severe: 7 },
};

/**
 * Runs the prototype triage engine.
 * @param {object} input
 *  age:number, gender:string,
 *  symptoms:[{code,severity}], symptomNotes:string,
 *  vitals:{temperature,heartRate,systolicBp,diastolicBp,spo2,respiratoryRate},
 *  history:[string]
 * @returns {{riskScore:number, priority:'CRITICAL'|'URGENT'|'NORMAL', factors:Array, modelVersion:string}}
 */
export function runTriageEngine(input) {
  const factors = [];
  let score = 0;
  const add = (weight, code, text) => {
    if (weight <= 0) return;
    score += weight;
    factors.push({ code, weight, text });
  };

  // --- vitals ---------------------------------------------------------
  const v = input.vitals || {};
  // NOTE: Number('') is 0, not NaN — an unfilled field must never be read
  // as a real (critical-looking) zero reading, so every vital is parsed
  // through this guard before any threshold check runs.
  const numOrNull = (x) => (x === '' || x == null ? null : (isNaN(Number(x)) ? null : Number(x)));
  const spo2 = numOrNull(v.spo2);
  if (spo2 != null) {
    if (spo2 < 90) add(28, 'vital_spo2', `SpO₂ critically low (${spo2}%)`);
    else if (spo2 < 95) add(14, 'vital_spo2', `SpO₂ below normal (${spo2}%)`);
  }
  const hr = numOrNull(v.heartRate);
  if (hr != null) {
    if (hr > 130 || hr < 40) add(19, 'vital_hr', `Heart rate critically abnormal (${hr} bpm)`);
    else if (hr > 100 || hr < 60) add(9, 'vital_hr', `Heart rate elevated/low (${hr} bpm)`);
  }
  const sbp = numOrNull(v.systolicBp);
  if (sbp != null) {
    if (sbp < 80 || sbp > 180) add(19, 'vital_sbp', `Systolic BP critically abnormal (${sbp} mmHg)`);
    else if (sbp < 90 || sbp > 140) add(9, 'vital_sbp', `Systolic BP outside normal range (${sbp} mmHg)`);
  }
  const rr = numOrNull(v.respiratoryRate);
  if (rr != null) {
    if (rr > 30 || rr < 8) add(19, 'vital_rr', `Respiratory rate critically abnormal (${rr}/min)`);
    else if (rr > 20 || rr < 12) add(9, 'vital_rr', `Respiratory rate outside normal range (${rr}/min)`);
  }
  const temp = numOrNull(v.temperature);
  if (temp != null) {
    if (temp > 39.5 || temp < 35) add(14, 'vital_temp', `Temperature critically abnormal (${temp}°C)`);
    else if (temp > 37.8) add(7, 'vital_temp', `Fever detected (${temp}°C)`);
  }
  const dbp = numOrNull(v.diastolicBp);
  if (dbp != null && (dbp < 50 || dbp > 100)) add(6, 'vital_dbp', `Diastolic BP outside normal range (${dbp} mmHg)`);

  // --- symptoms ---------------------------------------------------------
  const symptoms = input.symptoms || [];
  const symptomCodes = new Set(symptoms.map(s => s.code));
  symptoms.forEach(s => {
    const w = SYMPTOM_WEIGHTS[s.code] || SYMPTOM_WEIGHTS.other;
    const weight = w[s.severity] ?? w.mild;
    add(weight, `symptom_${s.code}`, `${symptomLabelText(s.code)} reported (${s.severity})`);
  });

  // --- history modifiers --------------------------------------------
  const hist = new Set(input.history || []);
  if (hist.has('cardiac')) {
    add(8, 'hist_cardiac', 'Cardiac history on record');
    if (symptomCodes.has('chest_pain')) add(10, 'hist_cardiac_chest', 'Cardiac history + chest pain combination');
  }
  if (hist.has('asthma') && symptomCodes.has('breathing_difficulty')) {
    add(9, 'hist_asthma_breath', 'Asthma history + breathing difficulty combination');
  } else if (hist.has('asthma')) {
    add(3, 'hist_asthma', 'Asthma on record');
  }
  if (hist.has('hypertension')) {
    const bpAbnormal = (sbp != null && (sbp < 90 || sbp > 140));
    add(bpAbnormal ? 10 : 4, 'hist_htn', 'Hypertension on record' + (bpAbnormal ? ' + abnormal BP' : ''));
  }
  if (hist.has('diabetes')) add(4, 'hist_diabetes', 'Diabetes on record');
  if (hist.has('prev_hospitalization')) add(3, 'hist_hosp', 'Previous hospitalization on record');

  // --- age modifier ---------------------------------------------------
  const age = Number(input.age);
  if (!isNaN(age)) {
    if (age >= 65) add(7, 'age_elderly', `Age ${age} — elderly risk modifier`);
    else if (age <= 5) add(7, 'age_pediatric', `Age ${age} — pediatric risk modifier`);
  }

  const riskScore = Math.max(0, Math.min(100, Math.round(score)));
  const priority = riskScore >= 75 ? 'CRITICAL' : riskScore >= 40 ? 'URGENT' : 'NORMAL';

  factors.sort((a, b) => b.weight - a.weight);

  return {
    riskScore,
    priority,
    factors: factors.slice(0, 8).map(f => ({ label: f.text, weight: f.weight })),
    modelVersion: MODEL_VERSION,
  };
}

function symptomLabelText(code) {
  const map = {
    chest_pain: 'Chest pain', breathing_difficulty: 'Breathing difficulty', fever: 'Fever',
    severe_headache: 'Severe headache', dizziness: 'Dizziness', abdominal_pain: 'Abdominal pain',
    vomiting: 'Vomiting', bleeding: 'Bleeding', seizure: 'Seizure', unconsciousness: 'Unconsciousness',
    weakness: 'Weakness', cough: 'Cough', other: 'Other symptom',
  };
  return map[code] || code;
}

// Illustrative weight table shown in the Admin → "How the engine scores"
// panel, generated straight from the tables above (never hand-typed twice).
export function weightTableRows() {
  const rows = [];
  Object.entries(SYMPTOM_WEIGHTS).forEach(([code, w]) => {
    rows.push({ factor: symptomLabelText(code), mild: w.mild, moderate: w.moderate, severe: w.severe });
  });
  return rows;
}

// ---------------------------------------------------------------------
// Synthetic evaluation harness (Admin → Model Evaluation).
// There is no real trained model and no real patient dataset in this
// browser-only build (see the PROTOTYPE NOTICE above), so accuracy /
// precision / recall / F1 figures are never hand-typed. Instead this
// generates a fresh, clearly-synthetic labeled dataset — feature values
// correlated with a hidden "true acuity" the engine never sees directly —
// and genuinely scores the heuristic engine's predictions against it, the
// way evaluate.py would score a trained model against a held-out split.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SYMPTOM_POOL = ['chest_pain', 'breathing_difficulty', 'fever', 'severe_headache', 'dizziness', 'abdominal_pain', 'vomiting', 'bleeding', 'weakness', 'cough'];

export function generateSyntheticEvalSet(n = 250, seed = Date.now() % 100000) {
  const rand = mulberry32(seed);
  const cases = [];
  for (let i = 0; i < n; i++) {
    const acuity = rand();
    const trueLabel = acuity > 0.72 ? 'CRITICAL' : acuity > 0.38 ? 'URGENT' : 'NORMAL';
    const age = Math.round(5 + rand() * 85);
    const spo2 = Math.round(99 - acuity * 18 - rand() * 4);
    const heartRate = Math.round(75 + acuity * 55 + (rand() - 0.5) * 20);
    const systolicBp = Math.round(118 - acuity * 45 + (rand() - 0.5) * 24);
    const respiratoryRate = Math.round(15 + acuity * 16 + (rand() - 0.5) * 6);
    const temperature = +(36.8 + acuity * 2.6 + (rand() - 0.5) * 0.8).toFixed(1);
    const diastolicBp = Math.round(76 - acuity * 20 + (rand() - 0.5) * 10);
    const nSym = 1 + Math.round(rand() * (1 + acuity * 3));
    const symptoms = [];
    for (let k = 0; k < nSym; k++) {
      const code = SYMPTOM_POOL[Math.floor(rand() * SYMPTOM_POOL.length)];
      const sevRoll = rand() * (0.4 + acuity);
      const severity = sevRoll > 0.66 ? 'severe' : sevRoll > 0.33 ? 'moderate' : 'mild';
      if (!symptoms.find(s => s.code === code)) symptoms.push({ code, severity });
    }
    const history = rand() < 0.15 * (1 + acuity) ? ['cardiac'] : rand() < 0.12 ? ['diabetes'] : [];
    cases.push({
      input: { age, gender: rand() < 0.5 ? 'female' : 'male', symptoms, history, vitals: { temperature, heartRate, systolicBp, diastolicBp, spo2, respiratoryRate } },
      trueLabel,
    });
  }
  return cases;
}

export function evaluateEngine(n = 250) {
  const set = generateSyntheticEvalSet(n);
  const labels = ['CRITICAL', 'URGENT', 'NORMAL'];
  const matrix = {}; labels.forEach(a => { matrix[a] = {}; labels.forEach(b => matrix[a][b] = 0); });
  let correct = 0;
  set.forEach(({ input, trueLabel }) => {
    const { priority } = runTriageEngine(input);
    matrix[trueLabel][priority]++;
    if (priority === trueLabel) correct++;
  });
  const perClass = labels.map(lbl => {
    const tp = matrix[lbl][lbl];
    const fp = labels.reduce((s, l) => s + (l !== lbl ? matrix[l][lbl] : 0), 0);
    const fn = labels.reduce((s, l) => s + (l !== lbl ? matrix[lbl][l] : 0), 0);
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return { label: lbl, precision, recall, f1 };
  });
  const macroPrecision = perClass.reduce((s, c) => s + c.precision, 0) / labels.length;
  const macroRecall = perClass.reduce((s, c) => s + c.recall, 0) / labels.length;
  const macroF1 = perClass.reduce((s, c) => s + c.f1, 0) / labels.length;
  return { n, accuracy: correct / n, macroPrecision, macroRecall, macroF1, perClass, matrix, labels };
}
