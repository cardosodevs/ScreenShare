window.RISE_CONFIG = {
  // Mesmo projeto Supabase do ECCO Vision (tabelas rise_* separadas).
  // Project Settings > API: URL e chave publishable (sb_publishable_...).
  SUPABASE_URL: 'https://xuggxyiavfkslmjnpysp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_r2qghRxQJyc9yDl8gqTgdA_Kc3uazDP',

  ROOM_TTL_HOURS: 3,

  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};
