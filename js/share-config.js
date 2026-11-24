// share-config.js: where shared sessions are stored (a Supabase project).
// Fill in your project's URL and its public "anon" key, from Supabase:
//   Project Settings > API > Project URL, and the publishable key (sb_publishable_...) or the older anon / public key.
// The anon key is meant to be public: the database only allows the share functions in
// supabase/shared-sessions.sql, which check the code, the passcode and the 24-hour expiry.
// Leave both empty to hide sharing.
window.PBQ_SHARE_CONFIG = {
  url: 'https://tjytzzhbggsvfofrqcxz.supabase.co',
  anonKey: 'sb_publishable_F0e7OemaInRfzQzOvbug4Q_3PrHO3F7',
};
