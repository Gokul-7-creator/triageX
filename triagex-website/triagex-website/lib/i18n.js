// TRIAGE-X — i18n & clinical vocabulary
// Symptom / history CODES are the stable, language-independent identifiers
// stored in the database and fed to the triage engine as features. Labels
// below are translations of those codes for the UI only — the engine never
// sees language, only codes.

export const SYMPTOMS = [
  { code: 'chest_pain',            icon: '🫀', en: 'Chest Pain',            ta: 'மார்பு வலி' },
  { code: 'breathing_difficulty',  icon: '🌬️', en: 'Breathing Difficulty',  ta: 'மூச்சு விடுவதில் சிரமம்' },
  { code: 'fever',                 icon: '🌡️', en: 'Fever',                 ta: 'காய்ச்சல்' },
  { code: 'severe_headache',       icon: '🤕', en: 'Severe Headache',       ta: 'கடுமையான தலைவலி' },
  { code: 'dizziness',             icon: '💫', en: 'Dizziness',             ta: 'தலைசுற்றல்' },
  { code: 'abdominal_pain',        icon: '⭕', en: 'Abdominal Pain',        ta: 'வயிற்று வலி' },
  { code: 'vomiting',              icon: '🤢', en: 'Vomiting',              ta: 'வாந்தி' },
  { code: 'bleeding',              icon: '🩸', en: 'Bleeding',              ta: 'இரத்தப்போக்கு' },
  { code: 'seizure',               icon: '⚡', en: 'Seizure',               ta: 'வலிப்பு' },
  { code: 'unconsciousness',       icon: '😵', en: 'Unconsciousness',       ta: 'மயக்க நிலை' },
  { code: 'weakness',              icon: '🧍', en: 'Weakness',              ta: 'பலவீனம்' },
  { code: 'cough',                 icon: '😷', en: 'Cough',                 ta: 'இருமல்' },
  { code: 'other',                 icon: '➕', en: 'Other',                 ta: 'மற்றவை' },
];

export const SEVERITIES = [
  { code: 'mild',     en: 'Mild',     ta: 'லேசான' },
  { code: 'moderate', en: 'Moderate', ta: 'மிதமான' },
  { code: 'severe',   en: 'Severe',   ta: 'கடுமையான' },
];

export const HISTORY_ITEMS = [
  { code: 'diabetes',            en: 'Diabetes',                  ta: 'நீரிழிவு நோய்' },
  { code: 'hypertension',        en: 'Hypertension',              ta: 'உயர் இரத்த அழுத்தம்' },
  { code: 'cardiac',             en: 'Cardiac History',           ta: 'இதய நோய் வரலாறு' },
  { code: 'asthma',              en: 'Asthma',                    ta: 'ஆஸ்துமா' },
  { code: 'prev_hospitalization',en: 'Previous Hospitalization',  ta: 'முந்தைய மருத்துவமனை அனுமதி' },
  { code: 'prev_surgery',        en: 'Previous Surgery',          ta: 'முந்தைய அறுவை சிகிச்சை' },
  { code: 'medication',          en: 'On Medication',             ta: 'மருந்து உட்கொள்கிறார்' },
  { code: 'allergies',           en: 'Allergies',                 ta: 'ஒவ்வாமை' },
  { code: 'other',               en: 'Other',                     ta: 'மற்றவை' },
  { code: 'none',                en: 'None Known',                ta: 'எதுவும் இல்லை' },
];

export const PRIORITY_LABELS = {
  CRITICAL: { en: 'Critical', ta: 'மிக அவசரம்', icon: '🔴' },
  URGENT:   { en: 'Urgent',   ta: 'அவசரம்',      icon: '🟠' },
  NORMAL:   { en: 'Normal',  ta: 'சாதாரணம்',     icon: '🟢' },
};

export const STATUS_LABELS = {
  waiting:                { en: 'Waiting',                ta: 'காத்திருக்கிறார்' },
  called:                 { en: 'Called',                 ta: 'அழைக்கப்பட்டது' },
  in_consultation:        { en: 'In Consultation',        ta: 'ஆலோசனையில்' },
  reassessment_required:  { en: 'Reassessment Required',  ta: 'மறு மதிப்பீடு தேவை' },
  emergency:              { en: 'Emergency',              ta: 'அவசர நிலை' },
  completed:              { en: 'Completed',              ta: 'முடிந்தது' },
};

const DICT = {
  en: {
    tagline: 'Intelligent prioritization. Explainable decisions. Real-time hospital coordination.',
    nav_dashboard: 'Doctor Dashboard',
    nav_checkin: 'Patient Check-in',
    nav_analytics: 'Analytics',
    nav_admin: 'Admin',
    nav_notifications: 'Notifications',
    cta_checkin: 'Patient Check-in',
    cta_dashboard: 'Hospital Dashboard',
  },
  ta: {
    tagline: 'அறிவார்ந்த முன்னுரிமை. விளக்கக்கூடிய முடிவுகள். நேரடி மருத்துவமனை ஒருங்கிணைப்பு.',
    nav_dashboard: 'மருத்துவர் டாஷ்போர்டு',
    nav_checkin: 'நோயாளி பதிவு',
    nav_analytics: 'பகுப்பாய்வு',
    nav_admin: 'நிர்வாகம்',
    nav_notifications: 'அறிவிப்புகள்',
    cta_checkin: 'நோயாளி பதிவு',
    cta_dashboard: 'மருத்துவமனை டாஷ்போர்டு',
  },
};

export function getLang() {
  try { return localStorage.getItem('triagex_lang') || 'en'; } catch (e) { return 'en'; }
}
export function setLang(lang) {
  try { localStorage.setItem('triagex_lang', lang); } catch (e) {}
}
export function t(key) {
  const lang = getLang();
  return (DICT[lang] && DICT[lang][key]) || DICT.en[key] || key;
}
export function label(entry) {
  const lang = getLang();
  if (!entry) return '';
  return entry[lang] || entry.en;
}
export function findByCode(list, code) {
  return list.find(x => x.code === code);
}
