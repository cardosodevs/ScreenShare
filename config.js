window.RISE_CONFIG = {
  // Mesmo projeto Supabase do ECCO Vision (tabelas rise_* separadas).
  // Project Settings > API: URL e chave publishable (sb_publishable_...).
  SUPABASE_URL: 'https://wlqsuswepqsvhxodlxza.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_bjmg_lT2e_m4iA-xGPrQMw_UBiqr2Jx',

  ROOM_TTL_HOURS: 3,

  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};
