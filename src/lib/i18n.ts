// Tekstet e sistemit (jo përgjigjet e AI — ato ndjekin gjuhën e klientit).
// Gjuha zgjidhet për tenant me settings.language.
const STRINGS = {
  en: {
    welcome: 'Hi! How can I help you?',
    handoff: 'I am passing your message to our team. Someone will reply here as soon as possible.',
    error: 'Sorry, something went wrong on our side. Please try again in a moment.',
    nonText: 'I can only read text messages for now. Please type your question.',
    placeholder: 'Type your message…',
    send: 'Send',
    title: 'Chat with us',
  },
  sq: {
    welcome: 'Përshëndetje! Si mund t’ju ndihmoj?',
    handoff: 'Po ia kaloj mesazhin tuaj ekipit tonë. Dikush do t’ju përgjigjet këtu sa më shpejt.',
    error: 'Na vjen keq, pati një problem teknik. Ju lutem provoni sërish pas pak.',
    nonText: 'Për momentin lexoj vetëm mesazhe me tekst. Ju lutem shkruani pyetjen tuaj.',
    placeholder: 'Shkruani mesazhin…',
    send: 'Dërgo',
    title: 'Bisedoni me ne',
  },
} as const;

export type Locale = keyof typeof STRINGS;
export type StringKey = keyof (typeof STRINGS)['en'];

export function localeOf(language: unknown): Locale {
  return language === 'sq' ? 'sq' : 'en';
}

export function t(language: unknown, key: StringKey): string {
  return STRINGS[localeOf(language)][key];
}
