/* =====================================================================
   agent-vocal.js — extension du back-office SAIOS : « Agent vocal » (LiveKit)
   Ajoute un groupe « Agent vocal » au menu Paramétrages (4 entrées).
   Ne modifie aucune fonction existante : deux fonctions sont simplement
   enveloppées (switchParamSection, loadParamData) pour ajouter nos sections.
   Tables utilisées : agent_config, agent_config_versions, agent_prompts,
   catalogue_modeles, operations_groupees (voir agent_vocal_etape1.sql).
   ===================================================================== */
(function () {
  'use strict';
  if (typeof supabaseClient === 'undefined' || !document.getElementById('param-nav') || window.__agentVocalCharge) {
    console.warn('[agent-vocal] extension non chargée (page inattendue ou déjà chargée)');
    return;
  }
  window.__agentVocalCharge = true;

  /* ---------- Constantes ---------- */
  var SECTIONS = {
    av_agents: 'Agents vocaux',
    av_modeles: 'Catalogue des modèles',
    av_prompts: 'Prompts de l\'agent',
    av_historique: 'Modifications groupées'
  };
  // Coûts fixes par minute d'appel (grille LiveKit et Twilio France du 30/09/2026) — à mettre à jour si les tarifs changent
  var FIXES = { agent: 0.01, pont: 0.004, twilio: 0.01 };
  var FIXES_SUM = FIXES.agent + FIXES.pont + FIXES.twilio;
  // Options payantes (grilles Twilio France du 30/09/2026) — à mettre à jour si les tarifs changent
  var SMS_SEGMENT = 0.0798;                 // dollars par SMS (segment) envoyé vers la France
  var TRANSFERT = { fixe: 0.0187, mobile: 0.0404, entrant: 0.01 }; // dollars par minute de conversation transférée
  var STATUTS = {
    recommande: ['Recommandé', 'info'], teste_ok: ['Testé OK', 'ok'], non_teste: ['Non testé', 'warn'],
    a_eviter: ['À éviter', 'bad'], retire: ['Retiré', 'bad']
  };
  var TYPE_LABEL = { stt: 'Écoute (STT)', llm: 'Cerveau (LLM)', tts: 'Voix (TTS)' };
  var ETAPES = ['Restaurant', 'Menu', 'Profil', 'Réglages', 'Numéro', 'Test'];

  var OPT = {
    lang: [['fr', 'Français'], ['multi', 'Multilingue (détection automatique)']],
    maxtok: [[150, '150 tokens'], [300, '300 tokens'], [600, '600 tokens']],
    turn: [['multilingual_model', 'Modèle LiveKit multilingue'], ['vad', 'Détection de voix seule'], ['stt', 'Via le STT']],
    think: [['none', 'Aucun'], ['keyboard1', 'Clavier 1'], ['keyboard2', 'Clavier 2'], ['keyboard_mix', 'Mélange clavier 1 et 2']],
    amb: [['none', 'Aucune'], ['office', 'Ambiance bureau']],
    noise: [['none', 'Aucune'], ['standard', 'Standard'], ['telephony', 'Téléphonie']],
    retention: [[7, '7 jours'], [30, '30 jours'], [90, '90 jours']],
    transfer: [['cold', 'Direct (sans annonce)'], ['warm', 'Avec annonce (l\'agent résume la commande)']]
  };
  var f1 = function (v) { return Number(v).toFixed(1).replace('.', ','); };
  var pct = function (v) { return Math.round(v * 100) + ' %'; };

  var SCHEMA = [
    { id: 'models', title: 'Modèles et voix', fields: [
      { k: 'info_branche', t: 'info', l: 'Ce que l\'agent applique à chaque appel', h: 'Quand l\'agent est « en service », il applique : écoute (modèle, langue), cerveau (modèle), voix (modèle, identifiant, vitesse), modèles de secours, mode expressif, fin de tour, attentes, interruptions, réponse anticipée, sons, suppression de bruit et le prompt choisi. Pas encore branchés : température, plafond de réponse, mots à reconnaître, transfert vers un humain et SMS. Hors service, l\'agent garde les réglages de son déploiement. Un modèle choisi ici est toujours doublé par la combinaison de référence du déploiement : si le modèle ne répond pas, l\'appel continue.', links: [] },
      { k: 'stt_model', t: 'model', mt: 'stt', l: 'Écoute (STT)' },
      { k: 'stt_lang', t: 'select', l: 'Langue d\'écoute', o: OPT.lang },
      { k: 'stt_kw', t: 'text', l: 'Mots à reconnaître (plats, marques)', h: 'Séparés par des virgules', adv: 1 },
      { k: 'llm_model', t: 'model', mt: 'llm', l: 'Cerveau (LLM)' },
      { k: 'llm_temp', t: 'range', l: 'Température', min: 0, max: 1, step: 0.1, fmt: f1, h: 'Plus bas = réponses plus stables' },
      { k: 'llm_maxtok', t: 'select', num: 1, l: 'Plafond de longueur de réponse', o: OPT.maxtok, h: 'Limite de sécurité, pas la longueur visée : 300 tokens ≈ 150 à 200 mots. Trop bas, il peut couper un appel d\'outil.' },
      { k: 'llm_par', t: 'toggle', l: 'Appels d\'outils en parallèle', adv: 1 },
      { k: 'tts_model', t: 'model', mt: 'tts', l: 'Voix (TTS)' },
      { k: 'tts_voice_id', t: 'text', l: 'Identifiant de la voix', ph: '[identifiant fourni par le fournisseur]', h: 'Vide = voix par défaut du fournisseur.' },
      { k: 'tts_speed', t: 'range', l: 'Vitesse de parole', min: 0.7, max: 1.3, step: 0.05, fmt: function (v) { return Number(v).toFixed(2).replace('.', ',') + '×'; } },
      { k: 'fb_llm', t: 'model', mt: 'llm', none: 1, l: 'LLM de secours', h: 'Prend le relais si le LLM principal ne répond plus.' },
      { k: 'fb_tts', t: 'model', mt: 'tts', none: 1, l: 'Voix de secours', adv: 1 },
      { k: 'fb_stt', t: 'model', mt: 'stt', none: 1, l: 'Écoute de secours', adv: 1 }
    ] },
    { id: 'conv', title: 'Conversation', fields: [
      { k: 'turn', t: 'select', l: 'Détection de fin de tour', o: OPT.turn },
      { k: 'd_min', t: 'range', l: 'Attente avant de répondre', min: 0.2, max: 2, step: 0.1, fmt: function (v) { return f1(v) + ' s'; } },
      { k: 'd_max', t: 'range', l: 'Attente maximale', min: 1, max: 6, step: 0.5, fmt: function (v) { return f1(v) + ' s'; } },
      { k: 'inter', t: 'toggle', l: 'Interruptions autorisées', h: 'Le client peut couper la parole à l\'agent.' },
      { k: 'int_words', t: 'range', l: 'Mots minimum pour couper', min: 1, max: 5, step: 1, fmt: function (v) { return v + ' mot(s)'; } },
      { k: 'preempt', t: 'toggle', l: 'Réponse anticipée', h: 'Prépare la réponse avant la fin de la phrase.' },
      { k: 'expressif', t: 'toggle', l: 'Mode expressif', h: 'Voix plus naturelle (émotion, rythme). Compatible : Fish Audio S2.1 Pro, Inworld TTS 2.0, Cartesia Sonic, xAI. Sans effet avec les autres voix ; peut ajouter un peu de latence.' },
      { k: 'disfluences', t: 'toggle', l: 'Autoriser les hésitations (« euh »)', h: 'Réglage de départ de LiveKit : activé, en anglais. Laisser désactivé.', adv: 1 },
      { k: 'vad', t: 'range', l: 'Seuil de détection de voix', h: 'Plus bas : l\'agent détecte aussi les voix faibles, mais réagit davantage au bruit. Par défaut 0,5. Essayer 0,3 si l\'agent n\'entend pas bien.', min: 0.1, max: 0.9, step: 0.05, fmt: function (v) { return Number(v).toFixed(2).replace('.', ','); }, adv: 1 }
    ] },
    { id: 'sounds', title: 'Sons', fields: [
      { k: 'think', t: 'select', l: 'Son de réflexion (pendant les outils)', o: OPT.think, h: 'Comble le blanc pendant que l\'agent travaille.' },
      { k: 'think_vol', t: 'range', l: 'Volume du son de réflexion', min: 0, max: 1, step: 0.05, fmt: pct },
      { k: 'amb', t: 'select', l: 'Ambiance de fond', o: OPT.amb },
      { k: 'amb_vol', t: 'range', l: 'Volume d\'ambiance', min: 0, max: 1, step: 0.05, fmt: pct },
      { k: 'tool_snd', t: 'select', l: 'Son pendant les outils du panier', o: OPT.think, h: 'Joué pendant chaque outil du panier (ajout, modification, retrait, informations, validation). Sans effet si un son de réflexion est choisi ci-dessus : celui-ci couvre déjà ces moments.' },
      { k: 'noise', t: 'select', l: 'Suppression de bruit', o: OPT.noise, adv: 1 }
    ] },
    { id: 'prompt', title: 'Prompt', fields: [
      { k: 'prompt_modele', t: 'prompt', l: 'Prompt de l\'agent', h: 'Modifié dans « Prompts de l\'agent » : le changement s\'applique à tous les agents qui l\'utilisent.' },
      { k: 'info_ailleurs', t: 'info', l: 'Déjà réglés dans les sections existantes (pas de doublon ici)', h: 'Messages d\'accueil, modes de commande, horaires, zones de livraison et menu se règlent là où ils sont déjà. L\'agent LiveKit les lit au décrochage. Les modifications non enregistrées de cet écran sont conservées si tu y reviens.', links: [['messages', 'Messages d\'accueil'], ['modes', 'Modes de commande'], ['horaires', 'Horaires'], ['zones', 'Zones de livraison'], ['produits', 'Produits (menu)']] }
    ] },
    { id: 'flow', title: 'Déroulé de l\'appel', fields: [
      { k: 'flow', t: 'flow', l: 'Étapes de l\'appel', h: 'Optionnel. Ce bloc n\'est utilisé que si le prompt contient le repère {{deroule_appel}} : il y est remplacé par ces étapes. Sans ce repère, ces réglages sont ignorés. Le calcul des prix reste verrouillé.' }
    ] },
    { id: 'tools', title: 'Outils', fields: [
      { k: 'tool_val', t: 'toggle', l: 'Panier et calcul des prix', locked: 1, h: 'Verrouillé : le panier est rempli par les outils ajouter, modifier, retirer et valider. Les prix sont calculés par les fonctions Supabase, jamais par le LLM.' },
      { k: 'tool_transfer', t: 'toggle', l: 'Transfert vers un humain', h: 'Pas d\'abonnement : on paie seulement les minutes de la conversation transférée (≈ 0,03 $/min vers un fixe, ≈ 0,05 $/min vers un mobile, estimation Twilio + entrant).' },
      { k: 'transfer_num', t: 'text', l: 'Numéro vers lequel transférer', ph: '+33…', h: 'Obligatoire si le transfert est activé.' },
      { k: 'transfer_mode', t: 'select', l: 'Type de transfert', o: OPT.transfer, h: 'Direct : simple et le moins cher. Avec annonce : l\'agent résume la commande avant de passer l\'appel (plus de minutes facturées).' },
      { k: 'transfer_phrase', t: 'text', l: 'Phrase avant le transfert', ph: 'Je vous passe un collaborateur…' },
      { k: 'transfer_open_only', t: 'toggle', l: 'Transférer seulement quand le restaurant est ouvert', h: 'Sinon l\'agent explique que personne n\'est disponible.' },
      { k: 'tool_sms', t: 'toggle', l: 'SMS de confirmation de commande', h: '≈ 0,08 $ par SMS de 160 caractères (0,16 $ s\'il en faut deux) : presque autant qu\'un appel entier. Désactivé par défaut.' },
      { k: 'sms_sender', t: 'text', l: 'Nom d\'expéditeur du SMS', ph: 'ex. DEMOPIZZA', h: '11 caractères maximum, lettres et chiffres. Le client ne peut pas répondre. Obligatoire si le SMS est activé.' },
      { k: 'sms_tpl', t: 'area', l: 'Texte du SMS', h: 'Variables : {{nom_restaurant}}, {{numero_commande}}, {{total}}, {{heure}}. Évite les accents rares (â, ê, ô…) : ils ramènent la limite à 70 caractères par SMS.' },
      { k: 'sms_modes', t: 'multi', l: 'SMS envoyé pour', o: ['a_emporter', 'livraison'], h: 'Limiter à la livraison réduit le coût.' }
    ] },
    { id: 'tel', title: 'Téléphonie', fields: [
      { k: 'numero_twilio', t: 'text', col: 1, l: 'Numéro Twilio de l\'agent', ph: '+33…', h: 'L\'achat du numéro reste manuel dans Twilio.' },
      { k: 'numero_public', t: 'text', col: 1, l: 'Numéro public du restaurant', ph: '+33…', h: 'Renvoyé par le restaurant vers le numéro Twilio.' },
      { k: 'maxdur', t: 'range', l: 'Durée maximale d\'appel', min: 3, max: 20, step: 1, fmt: function (v) { return v + ' min'; } },
      { k: 'sil_hang', t: 'range', l: 'Raccrocher après un silence de', min: 5, max: 60, step: 5, fmt: function (v) { return v + ' s'; } },
      { k: 'consent', t: 'toggle', l: 'Message de consentement à l\'enregistrement', h: 'Recommandé si l\'enregistrement est activé (règles exactes à valider).' }
    ] },
    { id: 'obs', title: 'Suivi et RGPD', fields: [
      { k: 'metrics', t: 'toggle', l: 'Métriques de latence et de coût' },
      { k: 'record', t: 'toggle', l: 'Enregistrement de l\'audio', h: 'Au choix par restaurant, désactivé par défaut.' },
      { k: 'retention', t: 'select', num: 1, l: 'Durée de conservation', o: OPT.retention },
      { k: 'mask', t: 'toggle', l: 'Masquer les données sensibles' }
    ] }
  ];
  var FM = {};
  SCHEMA.forEach(function (s) { s.fields.forEach(function (f) { FM[f.k] = f; }); });

  var FLOW0 = [
    { l: 'Mode de commande', on: true, lock: false, mand: true, phrase: 'Souhaitez-vous commander à emporter ou en livraison ?' },
    { l: 'Prise des produits', on: true, lock: true, mand: true, phrase: 'Que souhaitez-vous commander ?' },
    { l: 'Adresse de livraison', on: true, lock: false, mand: true, phrase: 'À quelle adresse souhaitez-vous être livré ?' },
    { l: 'Coordonnées du client', on: true, lock: false, mand: true, phrase: 'À quel nom, s\'il vous plaît ?' },
    { l: 'Récapitulatif et validation', on: true, lock: true, mand: true, phrase: 'Je récapitule votre commande.' },
    { l: 'Clôture', on: true, lock: false, mand: false, phrase: 'Merci, bonne journée !' }
  ];
  // Valeurs de départ (le profil Équilibré = BASE). Les réglages sont des données : en ajouter un = ajouter une ligne ci-dessus + ici.
  var BASE = {
    stt_model: 'deepgram/nova-3', stt_lang: 'fr', stt_kw: '',
    llm_model: 'google/gemini-3-flash-preview', llm_temp: 0.3, llm_maxtok: 300, llm_par: false,
    tts_model: 'inworld/inworld-tts-2', tts_voice_id: '', tts_speed: 1,
    fb_llm: 'openai/gpt-5-mini', fb_tts: '', fb_stt: '',
    turn: 'multilingual_model', d_min: 0.5, d_max: 3, inter: true, int_words: 2, preempt: true, vad: 0.5, expressif: false, disfluences: false,
    think: 'keyboard1', think_vol: 0.6, amb: 'none', amb_vol: 0.2, tool_snd: 'keyboard1', noise: 'telephony',
    prompt_modele: 'Modèle SAIOS restaurant (défaut)',
    flow: FLOW0, tool_val: true,
    tool_transfer: false, transfer_num: '', transfer_mode: 'cold', transfer_phrase: 'Je vous passe un collaborateur, ne quittez pas.', transfer_open_only: true,
    tool_sms: false, sms_sender: '', sms_tpl: '{{nom_restaurant}} : commande {{numero_commande}} confirmee, total {{total}}, prete a {{heure}}.', sms_modes: ['livraison'],
    maxdur: 10, sil_hang: 20, consent: false,
    metrics: true, record: false, retention: 30, mask: true
  };
  var PROFILS = {
    economique: { nom: 'Économique', o: { stt_model: 'assemblyai/universal-streaming-multilingual', llm_model: 'openai/gpt-5-mini', tts_model: 'fishaudio/s2-pro', fb_llm: 'openai/gpt-4o-mini' } },
    equilibre: { nom: 'Équilibré', o: {} },
    equilibre_ue: { nom: 'Équilibré (UE)', o: { llm_model: 'openai/gpt-5-mini', tts_model: 'deepgram/aura-2', fb_llm: 'google/gemma-4-31b-it' } },
    premium: { nom: 'Premium', o: { stt_model: 'deepgram/flux-general-multi', llm_model: 'openai/gpt-5.4-mini', tts_model: 'cartesia/sonic-3.6', fb_llm: 'google/gemini-3.7-flash' } }
  };
  var CLES_MODELES = ['stt_model', 'llm_model', 'tts_model', 'fb_llm', 'fb_tts', 'fb_stt'];
  var PAIRES = [['stt_model', 'fb_stt', 'stt'], ['llm_model', 'fb_llm', 'llm'], ['tts_model', 'fb_tts', 'tts']];

  /* ---------- Utilitaires ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var eq = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  var usd = function (n, d) { return Number(n).toFixed(d == null ? 4 : d).replace('.', ',') + ' $'; };
  var badge = function (t, k) { return '<span class="av-badge ' + (k || '') + '">' + esc(t) + '</span>'; };
  var mkProfil = function (p) { return clone(Object.assign({}, BASE, PROFILS[p].o)); };
  var pairs = function (o) { return Array.isArray(o) ? o : [o, o]; };

  /* ---------- État ---------- */
  var AV = {
    section: null, models: [], configs: [], prompts: [], ops: [],
    ed: null, bulk: null, filter: 'all', modelFilter: '', sel: {}, openSec: { models: true }, showAdv: false, catTab: 'llm'
  };

  var M = function (id) { return AV.models.find(function (m) { return m.identifiant === id; }); };
  var mname = function (id) { if (!id) return 'Aucun'; var m = M(id); return m ? m.nom : id; };
  var prix = function (id) { var m = M(id); return m && m.prix_minute != null ? Number(m.prix_minute) : 0; };
  var cfgOf = function (bid) { return AV.configs.find(function (c) { return c.business_id === bid; }); };
  var nomBiz = function (bid) { var b = (typeof businessesList !== 'undefined' ? businessesList : []).find(function (x) { return x.id === bid; }); return b ? b.nom : '(restaurant inconnu)'; };
  var sante = function (id) { var m = M(id); return m ? m.sante : 'ok'; };
  var resolu = function (row) { var r = row.reglages || {}, out = clone(BASE); Object.keys(BASE).forEach(function (k) { if (k in r) out[k] = clone(r[k]); }); return out; };
  var primaires = function (c) { return [c.stt_model, c.llm_model, c.tts_model]; };
  var coutDe = function (c) {
    var inc = primaires(c).some(function (id) { var m = M(id); return !m || m.prix_minute == null; });
    return { total: prix(c.stt_model) + prix(c.llm_model) + prix(c.tts_model) + FIXES_SUM, incomplet: inc };
  };
  var promptDe = function (nom) { return AV.prompts.find(function (p) { return p.nom === nom; }); };

  function statutAgent(row) {
    var c = resolu(row);
    var bad = false, secours = false, lent = false;
    PAIRES.forEach(function (p) {
      var h = sante(c[p[0]]);
      if (h === 'indisponible') { var fb = c[p[1]]; if (fb && sante(fb) !== 'indisponible') secours = true; else bad = true; }
      if (h === 'lent') lent = true;
    });
    if (bad) return ['Indisponible', 'bad'];
    if (secours) return ['Secours actif', 'warn'];
    if (lent) return ['Latence élevée', 'warn'];
    return ['OK', 'ok'];
  }

  /* ---------- Styles ---------- */
  var css = document.createElement('style');
  css.textContent = [
    '.av-root{max-width:900px}',
    '.av-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.05)}',
    '.av-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.av-between{justify-content:space-between}',
    '.av-grow{flex:1;min-width:0}',
    '.av-sub{font-size:12.5px;color:var(--muted)}',
    '.av-title{font-size:15px;font-weight:700;color:var(--ink);display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.av-badge{display:inline-block;padding:3px 8px;border-radius:6px;font-size:12px;font-weight:600;background:#eceef1;color:var(--ink);white-space:nowrap}',
    '.av-badge.ok{background:var(--ok-bg);color:var(--ok)}.av-badge.warn{background:var(--warn-bg);color:var(--warn)}',
    '.av-badge.bad{background:var(--err-bg);color:var(--err)}.av-badge.info{background:var(--info-bg);color:var(--info)}',
    '.av-badge.dark{background:var(--accent);color:#fff}',
    '.av-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
    '.av-chip{padding:3px 9px;border-radius:6px;background:#f2f3f5;border:1px solid var(--line);font-size:12px;font-weight:600;color:var(--ink)}',
    '.av-field{padding:12px 0;border-bottom:1px solid var(--line)}.av-field:last-child{border-bottom:none}',
    '.av-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}',
    '.av-l{font-size:14px;font-weight:600;color:var(--ink)}',
    '.av-field input[type=text],.av-field select,.av-field textarea,.av-in{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:14px;font-family:inherit;background:#fff}',
    '.av-field textarea{min-height:84px;resize:vertical}',
    '.av-field input[type=range]{width:100%}',
    '.av-help{font-size:12px;color:var(--muted);margin-top:5px}',
    '.av-reset{background:none;border:none;color:var(--info);font-size:12px;cursor:pointer;font-weight:600;padding:4px}',
    '.av-sechead{width:100%;background:none;border:none;font-size:15px;font-weight:700;color:var(--ink);display:flex;justify-content:space-between;align-items:center;padding:4px 0;cursor:pointer;font-family:inherit;text-align:left}',
    '.av-seg{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:4px;background:#eceef1;padding:4px;border-radius:10px;margin:10px 0}',
    '.av-seg button{border:none;border-radius:8px;background:transparent;color:var(--muted);font-size:13px;font-weight:600;padding:9px 6px;cursor:pointer;font-family:inherit}',
    '.av-seg button.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.12)}',
    '.av-steps{display:flex;justify-content:space-between;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 6px;margin:10px 0}',
    '.av-stp{display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;font-size:11px;color:var(--muted);background:none;border:none;cursor:pointer;font-family:inherit}',
    '.av-stp i{width:28px;height:28px;border-radius:50%;border:1px solid #cfd4da;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:13px;font-weight:700}',
    '.av-stp.done i{background:var(--ok);border-color:var(--ok);color:#fff}.av-stp.cur i{background:var(--accent);border-color:var(--accent);color:#fff}',
    '.av-bar{position:sticky;bottom:0;z-index:10;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-top:14px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;box-shadow:0 -4px 14px rgba(0,0,0,.1)}',
    '.av-alert{border-radius:10px;padding:12px 14px;margin-bottom:10px;font-size:13.5px;border:1px solid}',
    '.av-alert.bad{background:var(--err-bg);color:var(--err);border-color:var(--err)}.av-alert.warn{background:var(--warn-bg);color:var(--warn);border-color:var(--warn)}',
    '.av-alert .av-row{margin-top:8px}',
    '.av-kv{display:flex;justify-content:space-between;font-size:14px;padding:3px 0}',
    '.av-tbl{width:100%;border-collapse:collapse;font-size:13px}.av-tbl th,.av-tbl td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}',
    '.av-tbl th{font-size:11px;color:var(--muted);text-transform:uppercase}',
    '.av-up{color:var(--err);font-weight:700}.av-dn{color:var(--ok);font-weight:700}',
    '.av-chk{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:8px;background:#f2f3f5;border:1px solid var(--line);font-size:12px;cursor:pointer}',
    '.av-check{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:14px}',
    '.av-check input{width:18px;height:18px}',
    '.av-pre{background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:12px;font-family:monospace;font-size:12px;white-space:pre-wrap;max-height:420px;overflow:auto}'
  ].join('\n');
  document.head.appendChild(css);

  /* ---------- Menu et sections ---------- */
  (function installer() {
    var nav = $('param-nav');
    var bAgent = nav.querySelector('button[data-section="agent"]');
    var apres = bAgent ? bAgent.closest('.nav-groupe') : nav.lastElementChild;
    var g = document.createElement('div');
    g.className = 'nav-groupe';
    g.innerHTML = '<div class="nav-groupe-titre">Agent vocal</div>' + Object.keys(SECTIONS).map(function (k) {
      return '<button type="button" class="nav-item" data-section="' + k + '" onclick="allerSection(\'' + k + '\')"><span class="nav-pastille" id="pastille-' + k + '"></span><span class="nav-lib">' + esc(SECTIONS[k]) + '</span><span class="nav-compte" id="compte-' + k + '"></span></button>';
    }).join('');
    apres.parentNode.insertBefore(g, apres.nextSibling);
    var main = document.querySelector('.param-main');
    Object.keys(SECTIONS).forEach(function (k) {
      var d = document.createElement('div');
      d.id = 'param-' + k; d.className = 'param-section'; d.style.display = 'none';
      d.innerHTML = '<div class="av-root" id="avb-' + k + '"></div>';
      main.appendChild(d);
    });
  })();

  var _switch = window.switchParamSection;
  window.switchParamSection = function (section) {
    var r = _switch.apply(this, arguments);
    if (SECTIONS[section]) { var b = $('btn-add-param'); if (b) b.style.display = 'none'; }
    return r;
  };
  var _load = window.loadParamData;
  window.loadParamData = function () {
    if (SECTIONS[currentParamSection]) { AV.section = currentParamSection; return chargerEtRendre(); }
    return _load.apply(this, arguments);
  };

  /* ---------- Chargement ---------- */
  function messageErreur(err) {
    var manque = err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|schema cache/i.test(err.message || ''));
    return '<div class="no-data">❌ ' + (manque
      ? 'Les tables de l\'agent vocal n\'existent pas encore. Exécute d\'abord le script <strong>agent_vocal_etape1.sql</strong> dans Supabase (SQL Editor).'
      : esc(err && err.message ? err.message : String(err))) + '</div>';
  }
  async function charger() {
    var q = supabaseClient;
    var res = await Promise.all([
      q.from('catalogue_modeles').select('*').order('nom', { ascending: true }),
      q.from('agent_config').select('*'),
      q.from('agent_prompts').select('*').order('nom', { ascending: true }),
      q.from('operations_groupees').select('*').order('cree_le', { ascending: false }).limit(50)
    ]);
    var err = res.map(function (r) { return r.error; }).find(Boolean);
    if (err) throw err;
    AV.models = res[0].data || []; AV.configs = res[1].data || []; AV.prompts = res[2].data || []; AV.ops = res[3].data || [];
  }
  async function chargerEtRendre() {
    var body = $('avb-' + AV.section);
    if (!body) return;
    if (!AV.ed) body.innerHTML = '<div class="loading">🔄 Chargement…</div>';
    try { await charger(); } catch (err) { console.error(err); body.innerHTML = messageErreur(err); return; }
    rendre();
  }
  function majPastilles() {
    var set = function (k, n) { var p = $('pastille-' + k), c = $('compte-' + k); if (p) p.className = 'nav-pastille' + (n > 0 ? ' ok' : ''); if (c) c.textContent = n > 0 ? String(n) : ''; };
    set('av_agents', AV.configs.length); set('av_modeles', AV.models.length); set('av_prompts', AV.prompts.length); set('av_historique', AV.ops.length);
  }
  function rendre() {
    var y = window.scrollY;
    var body = $('avb-' + AV.section);
    if (!body) return;
    var h = '';
    if (AV.section === 'av_agents') h = AV.ed ? vueEditeur() : (AV.bulk ? vueGroupee() : vueAgents());
    else if (AV.section === 'av_modeles') h = vueCatalogue();
    else if (AV.section === 'av_prompts') h = vuePrompts();
    else h = vueHistorique();
    body.innerHTML = h;
    window.scrollTo(0, y);
    majPastilles();
  }

  /* ---------- Liste des agents ---------- */
  function vueAgents() {
    var biz = typeof businessesList !== 'undefined' ? businessesList : [];
    var h = '<div class="options-help">🎙️ Un agent par restaurant. Coche plusieurs agents pour les modifier ensemble (migration, incident d\'un modèle, forte latence). Les changements s\'appliquent dès l\'appel suivant.</div>';
    AV.models.forEach(function (m) {
      if (m.sante === 'ok') return;
      var n = AV.configs.filter(function (c) { return primaires(resolu(c)).indexOf(m.identifiant) >= 0; }).length;
      if (!n) return;
      h += '<div class="av-alert ' + (m.sante === 'indisponible' ? 'bad' : 'warn') + '"><b>' + esc(m.nom) + '</b> ' + (m.sante === 'indisponible' ? 'est indisponible' : 'répond lentement') + ' : ' + n + ' agent(s) concerné(s).<div class="av-row"><button class="btn btn-primary btn-sm" data-avact="urgence" data-id="' + esc(m.identifiant) + '">Basculer en urgence</button><button class="btn btn-secondary btn-sm" data-avact="fmodel" data-id="' + esc(m.identifiant) + '">Voir les agents</button></div></div>';
    });
    var filtres = [['all', 'Tous'], ['actifs', 'En service'], ['incident', 'Concernés par un incident'], ['sans', 'Sans agent']];
    h += '<div class="sel-toolbar">' + filtres.map(function (f) { return '<button class="btn ' + (AV.filter === f[0] && !AV.modelFilter ? 'btn-primary' : 'btn-secondary') + ' btn-sm" data-avact="filtre" data-id="' + f[0] + '">' + f[1] + '</button>'; }).join('') + '</div>';
    if (AV.modelFilter) h += '<div class="av-row" style="margin-bottom:10px">' + badge('Utilisant : ' + mname(AV.modelFilter), 'info') + '<button class="av-reset" data-avact="filtre" data-id="all">Retirer le filtre</button></div>';
    var liste = biz.filter(function (b) {
      var c = cfgOf(b.id);
      if (AV.modelFilter) return c && Object.keys(resolu(c)).some(function (k) { return CLES_MODELES.indexOf(k) >= 0 && resolu(c)[k] === AV.modelFilter; });
      if (AV.filter === 'actifs') return c && c.actif;
      if (AV.filter === 'incident') return c && statutAgent(c)[1] !== 'ok';
      if (AV.filter === 'sans') return !c;
      return true;
    });
    var nsel = Object.keys(AV.sel).filter(function (k) { return AV.sel[k]; }).length;
    h += '<div class="av-card av-row av-between"><span><b>' + nsel + '</b> sélectionné(s)</span><span class="av-row"><button class="btn btn-secondary btn-sm" data-avact="selall">Tout sélectionner</button><button class="btn btn-secondary btn-sm" data-avact="selnone">Aucun</button><button class="btn btn-primary btn-sm" data-avact="groupe"' + (nsel ? '' : ' disabled') + '>Modifier la sélection ›</button></span></div>';
    liste.forEach(function (b) {
      var c = cfgOf(b.id);
      var lieu = [b.ville, b.code_postal ? '(' + b.code_postal + ')' : ''].filter(Boolean).join(' ');
      if (!c) {
        h += '<div class="av-card av-row av-between"><div class="av-grow"><div class="av-title">' + esc(b.nom) + ' ' + badge('Sans agent vocal') + '</div><div class="av-sub">' + esc(lieu) + '</div></div><button class="btn btn-primary btn-sm" data-avact="creer" data-id="' + b.id + '">Créer l\'agent</button></div>';
        return;
      }
      var r = resolu(c), st = statutAgent(c), cout = coutDe(r);
      var prof = PROFILS[c.profil] ? mkProfil(c.profil) : null;
      var nperso = prof ? Object.keys(prof).filter(function (k) { return !eq(r[k], prof[k]); }).length : 0;
      h += '<div class="av-card av-row" style="align-items:flex-start"><input type="checkbox" data-avact="sel" data-id="' + b.id + '"' + (AV.sel[b.id] ? ' checked' : '') + ' style="margin-top:4px;width:18px;height:18px" aria-label="Sélectionner ' + esc(b.nom) + '"><div class="av-grow"><div class="av-title">' + esc(b.nom) + ' ' + badge(PROFILS[c.profil] ? PROFILS[c.profil].nom : c.profil) + badge('v' + c.version) + badge(c.actif ? 'En service' : 'Hors service', c.actif ? 'ok' : '') + badge(st[0], st[1]) + '</div>' +
        '<div class="av-sub">' + esc(lieu) + '</div><div class="av-sub">' + esc(mname(r.stt_model)) + ' · ' + esc(mname(r.llm_model)) + ' · ' + esc(mname(r.tts_model)) + '</div>' +
        '<div class="av-sub"><b>' + usd(cout.total) + '</b> / min' + (cout.incomplet ? ' (coût incomplet)' : '') + (nperso ? ' · ' + nperso + ' réglage(s) personnalisé(s)' : '') + '</div></div>' +
        '<div class="av-row"><button class="btn btn-secondary btn-sm" data-avact="editer" data-id="' + b.id + '">✏️ Modifier</button><button class="btn btn-secondary btn-sm" data-avact="service" data-id="' + b.id + '">' + (c.actif ? 'Retirer du service' : 'Mettre en service') + '</button></div></div>';
    });
    if (!liste.length) h += '<div class="no-data">Aucun restaurant pour ce filtre.</div>';
    return h;
  }

  /* ---------- Champs ---------- */
  function optionsModele(f, val) {
    var h = f.none ? '<option value=""' + (!val ? ' selected' : '') + '>Aucun</option>' : '';
    AV.models.filter(function (m) { return m.type === f.mt && (m.statut !== 'retire' || m.identifiant === val); }).forEach(function (m) {
      var tags = (m.endpoint_ue ? ' · UE' : ' · hors UE') + (m.francais === false ? ' · sans français' : '') + (m.sante === 'indisponible' ? ' · indisponible' : '') + (m.statut === 'a_eviter' ? ' · à éviter' : '');
      var dis = m.sante === 'indisponible' && m.identifiant !== val;
      h += '<option value="' + esc(m.identifiant) + '"' + (m.identifiant === val ? ' selected' : '') + (dis ? ' disabled' : '') + '>' + esc(m.nom) + ' — ' + (m.prix_minute != null ? usd(m.prix_minute) + '/min' : 'prix inconnu') + tags + '</option>';
    });
    if (val && !M(val)) h += '<option value="' + esc(val) + '" selected>' + esc(val) + ' (absent du catalogue)</option>';
    h += '<option value="__custom__">Autre modèle (saisir l\'identifiant)…</option>';
    return h;
  }
  function infoModele(id) {
    var m = M(id);
    if (!id) return '';
    if (!m) return '<div class="av-chips">' + badge('Absent du catalogue', 'bad') + '</div>';
    var h = '<div class="av-chips"><span class="av-chip">' + (m.prix_minute != null ? usd(m.prix_minute) + ' / min' : 'prix inconnu') + '</span>';
    if (m.prix_entree_mtok != null) h += '<span class="av-chip">entrée ' + usd(m.prix_entree_mtok, 2) + ' · sortie ' + usd(m.prix_sortie_mtok, 2) + ' / M tokens</span>';
    h += badge(m.endpoint_ue ? 'Endpoint UE' : 'Hors UE', m.endpoint_ue ? 'ok' : 'warn');
    if (m.francais === false) h += badge('Sans français', 'bad');
    h += badge(STATUTS[m.statut][0], STATUTS[m.statut][1]);
    if (m.hors_catalogue) h += badge('Hors catalogue', 'warn');
    if (m.sante === 'indisponible') h += badge('Indisponible', 'bad');
    if (m.sante === 'lent') h += badge('Latence élevée', 'warn');
    return h + '</div>';
  }
  function ctl(f, val, t) {
    var id = 'avf_' + t + '_' + f.k, d = 'data-avt="' + t + '" data-avk="' + f.k + '"';
    if (f.t === 'toggle') return '<input type="checkbox" id="' + id + '" ' + d + (val ? ' checked' : '') + (f.locked ? ' disabled' : '') + ' style="width:20px;height:20px">';
    if (f.t === 'range') return '<input type="range" id="' + id + '" ' + d + ' min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + val + '">';
    if (f.t === 'select') return '<select id="' + id + '" ' + d + '>' + f.o.map(function (o) { var p = pairs(o); return '<option value="' + esc(p[0]) + '"' + (String(p[0]) === String(val) ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('') + '</select>';
    if (f.t === 'text') return '<input type="text" id="' + id + '" ' + d + ' value="' + esc(val) + '" placeholder="' + esc(f.ph || '') + '">';
    if (f.t === 'area') return '<textarea id="' + id + '" ' + d + '>' + esc(val) + '</textarea>';
    if (f.t === 'multi') return '<div class="av-chips">' + f.o.map(function (o) { return '<label class="av-chk"><input type="checkbox" ' + d + ' data-avo="' + esc(o) + '"' + ((val || []).indexOf(o) >= 0 ? ' checked' : '') + '> ' + esc(o) + '</label>'; }).join('') + '</div>';
    if (f.t === 'model') return '<select id="' + id + '" ' + d + '>' + optionsModele(f, val) + '</select>';
    if (f.t === 'prompt') {
      var opts = AV.prompts.map(function (p) { return '<option value="' + esc(p.nom) + '"' + (p.nom === val ? ' selected' : '') + '>' + esc(p.nom) + '</option>'; }).join('');
      if (val && !promptDe(val)) opts += '<option value="' + esc(val) + '" selected>' + esc(val) + ' (introuvable)</option>';
      return '<select id="' + id + '" ' + d + '>' + opts + '</select>';
    }
    if (f.t === 'flow') return (val || []).map(function (st, i) {
      return '<div class="av-card" style="padding:12px 14px;margin-bottom:8px"><div class="av-row av-between"><label class="av-row av-l"><input type="checkbox" data-avt="flow" data-avk="' + i + '" data-avp="on"' + (st.on ? ' checked' : '') + (st.lock ? ' disabled' : '') + ' style="width:18px;height:18px"> ' + esc(st.l) + '</label>' + (st.lock ? badge('Toujours actif', 'dark') : '') + '</div><input type="text" class="av-in" style="margin-top:8px" data-avt="flow" data-avk="' + i + '" data-avp="phrase" value="' + esc(st.phrase) + '" aria-label="Phrase : ' + esc(st.l) + '"><label class="av-check"><input type="checkbox" data-avt="flow" data-avk="' + i + '" data-avp="mand"' + (st.mand ? ' checked' : '') + '> Question obligatoire</label></div>';
    }).join('');
    return '';
  }
  function formCustom(f) {
    var c = AV.ed && AV.ed.custom;
    if (!c || c.k !== f.k) return '';
    return '<div class="av-card" style="margin-top:8px"><b>Modèle hors catalogue</b><div class="av-field"><label class="av-l" for="avf_custom_id">Identifiant du modèle</label><input type="text" id="avf_custom_id" data-avt="custom" data-avk="id" value="' + esc(c.id) + '" placeholder="fournisseur/modele"></div><div class="av-field"><label class="av-l" for="avf_custom_pm">Prix par minute en $ (facultatif)</label><input type="text" id="avf_custom_pm" data-avt="custom" data-avk="pm" value="' + esc(c.pm) + '" placeholder="0,0000"><div class="av-help">Sans prix, le coût estimé est signalé incomplet. Le modèle est ajouté « non testé ».</div></div><div class="av-row"><button class="btn btn-primary btn-sm" data-avact="addcustom">Ajouter ce modèle</button><button class="btn btn-secondary btn-sm" data-avact="cancelcustom">Annuler</button></div></div>';
  }
  function ligneChamp(f, cfg, prof, t) {
    if (f.t === 'info') return '<div class="av-field"><div class="av-l">' + esc(f.l) + '</div><div class="av-help">' + esc(f.h) + '</div><div class="av-row" style="margin-top:8px">' + f.links.map(function (x) { return '<button class="btn btn-secondary btn-sm" data-avact="aller" data-id="' + x[0] + '">' + esc(x[1]) + ' ›</button>'; }).join('') + '</div></div>';
    var val = cfg[f.k], id = 'avf_' + t + '_' + f.k;
    var perso = prof && !f.col && !eq(val, prof[f.k]);
    var rs = perso ? badge('Personnalisé', 'warn') + '<button class="av-reset" data-avact="reset" data-id="' + f.k + '">Rétablir</button>' : '';
    var rv = f.t === 'range' ? '<b id="avlab_' + t + '_' + f.k + '">' + f.fmt(val) + '</b>' : '';
    var extra = '';
    if (f.t === 'model') extra = infoModele(val) + formCustom(f);
    if (f.t === 'prompt') { var p = promptDe(val); extra = '<div class="av-chips">' + (p ? (p.contenu && p.contenu.trim() ? badge(p.contenu.length + ' caractères', 'ok') : badge('Prompt vide : à compléter', 'bad')) : badge('Prompt introuvable', 'bad')) + '</div>'; }
    if (f.t === 'toggle') return '<div class="av-field"><div class="av-top" style="margin-bottom:0"><label class="av-l" for="' + id + '">' + esc(f.l) + (f.locked ? ' ' + badge('Verrouillé', 'dark') : '') + '</label><span class="av-row">' + rs + ctl(f, val, t) + '</span></div>' + (f.h ? '<div class="av-help">' + esc(f.h) + '</div>' : '') + '</div>';
    return '<div class="av-field"><div class="av-top"><label class="av-l" for="' + id + '">' + esc(f.l) + '</label><span class="av-row">' + rv + rs + '</span></div>' + ctl(f, val, t) + extra + (f.h ? '<div class="av-help">' + esc(f.h) + '</div>' : '') + '</div>';
  }
  function sections(cfg, prof) {
    return SCHEMA.map(function (sec) {
      var fs = sec.fields.filter(function (f) { return AV.showAdv || !f.adv; });
      var n = prof ? fs.filter(function (f) { return !f.col && !eq(cfg[f.k], prof[f.k]); }).length : 0;
      var ouvert = !!AV.openSec[sec.id];
      return '<div class="av-card"><button class="av-sechead" data-avact="sec" data-id="' + sec.id + '" aria-expanded="' + ouvert + '"><span>' + esc(sec.title) + '</span><span class="av-row">' + (n ? badge(n + ' personnalisé(s)', 'warn') : '') + '<span>' + (ouvert ? '▾' : '›') + '</span></span></button>' + (ouvert ? '<div>' + fs.map(function (f) { return ligneChamp(f, cfg, prof, 'cfg'); }).join('') + '</div>' : '') + '</div>';
    }).join('');
  }
  var advToggle = function () { return '<div class="av-row" style="margin:6px 0 10px"><label class="av-chk"><input type="checkbox" data-avact="adv"' + (AV.showAdv ? ' checked' : '') + '> Afficher les réglages avancés</label></div>'; };

  /* ---------- Éditeur (création et modification) ---------- */
  function aplatir(row) {
    var c = resolu(row);
    c.numero_twilio = row.numero_twilio || '';
    c.numero_public = row.numero_public || '';
    return c;
  }
  function changements() {
    var e = AV.ed;
    if (e.mode !== 'edit') return [];
    return Object.keys(e.cfg).filter(function (k) { return !eq(e.cfg[k], e.orig[k]); }).map(function (k) { return { k: k, from: e.orig[k], to: e.cfg[k] }; });
  }
  function fmtVal(k, v) {
    var f = FM[k];
    if (!f) return String(v);
    if (f.t === 'model') return v ? mname(v) : 'Aucun';
    if (f.t === 'toggle') return v ? 'Oui' : 'Non';
    if (f.t === 'range') return f.fmt(v);
    if (f.t === 'multi') return (v || []).join(', ') || '—';
    if (f.t === 'flow') return v.filter(function (x) { return x.on; }).length + ' étape(s) active(s)';
    if (f.t === 'select') { var o = f.o.map(pairs).find(function (p) { return String(p[0]) === String(v); }); return o ? o[1] : String(v); }
    return String(v == null || v === '' ? '—' : v);
  }
  function barre() {
    var e = AV.ed, c = coutDe(e.cfg);
    var h = '<div><b>' + usd(c.total) + '</b> / min · ≈ ' + usd(c.total * 3, 3) + ' pour 3 min<div class="av-sub">LiveKit + Twilio compris' + (c.incomplet ? ' · <b>coût incomplet (prix inconnu)</b>' : '') + (e.cfg.tool_sms ? ' · SMS : +' + usd(SMS_SEGMENT) + ' par commande' : '') + '</div></div>';
    if (e.mode === 'edit') {
      var n = changements().length;
      h += '<div class="av-row">' + (n ? '<button class="av-reset" data-avact="diff">' + n + ' modification(s)</button>' : '<span class="av-sub">Aucune modification</span>') + '<button class="btn btn-primary" data-avact="save"' + (n ? '' : ' disabled') + '>💾 Enregistrer (v' + (e.version + 1) + ')</button></div>';
    }
    return h;
  }
  function vueEditeur() {
    var e = AV.ed, prof = mkProfil(e.profil), h = '';
    if (e.mode === 'edit') {
      h += '<button class="av-reset" data-avact="quitter">‹ Agents vocaux</button><div class="av-row av-between"><h2 style="font-size:19px;margin:6px 0">' + esc(e.name) + '</h2><span class="av-row">' + badge(PROFILS[e.profil] ? PROFILS[e.profil].nom : e.profil) + badge('v' + e.version) + '</span></div><div class="av-sub">Chaque enregistrement crée une nouvelle version, restaurable. Application dès l\'appel suivant.</div>';
      h += advToggle() + sections(e.cfg, prof);
      if (e.showDiff) h += '<div class="av-card"><b>Modifications en attente</b>' + changements().map(function (c) { return '<div class="av-kv"><span>' + esc(FM[c.k] ? FM[c.k].l : c.k) + '</span><span>' + esc(fmtVal(c.k, c.from)) + ' → <b>' + esc(fmtVal(c.k, c.to)) + '</b></span></div>'; }).join('') + '</div>';
      h += '<div class="av-bar" id="avbar">' + barre() + '</div>';
      return h;
    }
    h += '<button class="av-reset" data-avact="quitter">‹ Annuler la création</button><h2 style="font-size:19px;margin:6px 0">Nouvel agent vocal</h2><div class="av-sub">Étape ' + e.step + ' sur 6 · ' + ETAPES[e.step - 1] + '</div>';
    h += '<div class="av-steps">' + ETAPES.map(function (s, i) { var n = i + 1, cl = n < e.step ? 'done' : (n === e.step ? 'cur' : ''); return '<button class="av-stp ' + cl + '" data-avact="etape" data-id="' + n + '"><i>' + (n < e.step ? '✓' : n) + '</i>' + s + '</button>'; }).join('') + '</div>';
    var nav = function (prev, next, label) { return '<div class="av-row" style="margin-top:14px">' + (prev ? '<button class="btn btn-secondary" data-avact="etape" data-id="' + prev + '">Retour</button>' : '') + (next ? '<button class="btn btn-primary" data-avact="etape" data-id="' + next + '">' + (label || 'Continuer') + '</button>' : '') + '</div>'; };
    var biz = (typeof businessesList !== 'undefined' ? businessesList : []);
    if (e.step === 1) {
      var libres = biz.filter(function (b) { return !cfgOf(b.id) || b.id === e.bid; });
      h += '<div class="av-card"><div class="av-field"><label class="av-l" for="avf_ed_bid">Restaurant</label><select id="avf_ed_bid" data-avt="ed" data-avk="bid"><option value="">— Choisir un restaurant —</option>' + libres.map(function (b) { return '<option value="' + b.id + '"' + (b.id === e.bid ? ' selected' : '') + '>' + esc(b.nom) + (b.ville ? ' — ' + esc(b.ville) : '') + '</option>'; }).join('') + '</select><div class="av-help">Seuls les restaurants sans agent LiveKit sont proposés. Restaurant absent ? Crée-le d\'abord :</div><div class="av-row" style="margin-top:8px"><button class="btn btn-secondary btn-sm" data-avact="newbiz">➕ Nouveau restaurant</button></div></div></div>' + nav(0, e.bid ? 2 : 0);
      if (!e.bid) h += '<div class="av-sub" style="margin-top:8px">Choisis un restaurant pour continuer.</div>';
    }
    if (e.step === 2) {
      var m = e.menu || {};
      var ligne = function (lib, n, section) { return '<div class="av-kv"><span>' + lib + '</span><span class="av-row">' + (n === undefined ? badge('…') : badge(n === null ? 'inconnu' : String(n), n ? 'ok' : 'warn')) + '<button class="av-reset" data-avact="aller" data-id="' + section + '">Ouvrir ›</button></span></div>'; };
      h += '<div class="av-card"><b>' + esc(nomBiz(e.bid)) + '</b><div class="av-sub" style="margin:4px 0 10px">Le menu, les horaires et les zones se préparent dans les sections existantes. L\'assistant reprend ici à ton retour.</div>' + ligne('Produits', m.produits, 'produits') + ligne('Zones de livraison', m.zones, 'zones') + ligne('Horaires (jours ouverts)', m.horaires, 'horaires') + ligne('Règles de l\'agent', m.regles, 'agent') + '<div class="av-row" style="margin-top:8px"><button class="btn btn-secondary btn-sm" data-avact="aller" data-id="api">🔌 Connexion API et import</button><button class="btn btn-secondary btn-sm" data-avact="recompter">🔄 Recompter</button></div></div>' + nav(1, 3);
    }
    if (e.step === 3) {
      Object.keys(PROFILS).forEach(function (p) {
        var c = mkProfil(p), co = coutDe(c), sel = e.profil === p && !e.copied;
        h += '<label class="av-card av-row" style="align-items:flex-start;border:2px solid ' + (sel ? 'var(--accent)' : 'var(--line)') + ';cursor:pointer"><input type="radio" name="avprof" data-avact="prof" data-id="' + p + '"' + (sel ? ' checked' : '') + ' style="width:18px;height:18px;margin-top:3px"><span class="av-grow"><b>' + esc(PROFILS[p].nom) + '</b>' + (p === 'equilibre' ? ' ' + badge('Par défaut', 'info') : '') + '<div class="av-sub">' + esc(mname(c.stt_model)) + ' · ' + esc(mname(c.llm_model)) + ' · ' + esc(mname(c.tts_model)) + '</div><div class="av-chips"><span class="av-chip">' + usd(co.total) + ' / min</span><span class="av-chip">≈ ' + usd(co.total * 3, 2) + ' / appel de 3 min</span>' + (primaires(c).every(function (id) { return M(id) && M(id).endpoint_ue; }) ? badge('100 % endpoints UE', 'ok') : badge('Certains modèles hors UE', 'warn')) + '</div></span></label>';
      });
      h += '<div class="av-card"><div class="av-l">Copier un agent existant</div><select data-avact="copy" class="av-in" style="margin-top:6px"><option value="">Choisir…</option>' + AV.configs.map(function (c) { return '<option value="' + c.business_id + '">' + esc(nomBiz(c.business_id)) + '</option>'; }).join('') + '</select>' + (e.copied ? '<div class="av-help">Configuration copiée depuis ' + esc(e.copied) + '.</div>' : '') + '</div><div class="av-sub">Coûts par minute d\'appel, Twilio et LiveKit compris. « Hors UE » : voir le réglage de restriction régionale dans LiveKit Cloud.</div>' + nav(2, 4);
    }
    if (e.step === 4) h += '<div class="hint av-alert warn" style="background:var(--info-bg);color:var(--info);border-color:var(--info)">Profil de départ : <b>' + esc(PROFILS[e.profil].nom) + '</b>. Les réglages modifiés sont marqués « Personnalisé ».</div>' + advToggle() + sections(e.cfg, prof) + nav(3, 5);
    if (e.step === 5) h += '<div class="av-card">' + ligneChamp(FM.numero_twilio, e.cfg, null, 'cfg') + ligneChamp(FM.numero_public, e.cfg, null, 'cfg') + '</div>' + nav(4, 6);
    if (e.step === 6) {
      var c2 = coutDe(e.cfg), nc = Object.keys(prof).filter(function (k) { return !eq(e.cfg[k], prof[k]); }).length;
      var p2 = promptDe(e.cfg.prompt_modele);
      var chk = function (ok, t) { return '<div class="av-kv"><span>' + t + '</span>' + badge(ok ? 'OK' : 'À faire', ok ? 'ok' : 'warn') + '</div>'; };
      var m2 = e.menu || {};
      h += '<div class="av-card"><b>' + esc(nomBiz(e.bid)) + '</b> ' + badge(PROFILS[e.profil].nom) + '<div class="av-sub" style="margin:4px 0 8px">' + esc(mname(e.cfg.stt_model)) + ' · ' + esc(mname(e.cfg.llm_model)) + ' · ' + esc(mname(e.cfg.tts_model)) + '</div><div class="av-kv"><span>Coût par minute</span><b>' + usd(c2.total) + '</b></div><div class="av-kv"><span>Appel de 3 minutes</span><b>≈ ' + usd(c2.total * 3, 3) + '</b></div><div class="av-kv"><span>Réglages personnalisés</span><b>' + nc + '</b></div></div>' +
        '<div class="av-card"><b>Avant la mise en service</b>' + chk(!!e.bid, 'Restaurant choisi') + chk((m2.produits || 0) > 0, 'Menu présent (produits)') + chk(!!(e.cfg.numero_twilio || '').trim(), 'Numéro Twilio renseigné') + chk(!!(p2 && p2.contenu && p2.contenu.trim()), 'Prompt non vide') + chk(primaires(e.cfg).every(function (id) { return sante(id) !== 'indisponible'; }), 'Modèles disponibles') + (e.cfg.tool_transfer ? chk(!!String(e.cfg.transfer_num || '').trim(), 'Numéro de transfert renseigné') : '') + (e.cfg.tool_sms ? chk(/^[A-Za-z0-9 ]{1,11}$/.test(String(e.cfg.sms_sender || '').trim()), 'Nom d\'expéditeur du SMS valide') : '') +
        '<label class="av-check"><input type="checkbox" data-avt="ed" data-avk="testOk"' + (e.testOk ? ' checked' : '') + '> Appel de test réussi (à cocher toi-même après avoir appelé le numéro)</label><div class="av-help">L\'agent est créé <b>hors service</b> ; tu le mets en service depuis la liste une fois le test réussi.</div></div>' + nav(5, 0) + '<div class="av-row" style="margin-top:8px"><button class="btn btn-primary" data-avact="create">✅ Créer l\'agent (hors service)</button></div>';
    }
    return h + '<div class="av-bar" id="avbar">' + barre() + '</div>';
  }

  /* ---------- Modification groupée ---------- */
  var bulkCibles = function () { return AV.configs.filter(function (c) { return AV.bulk.ids.indexOf(c.business_id) >= 0; }); };
  function modelesUtilises(type, rows) {
    var s = {};
    rows.forEach(function (c) { var r = resolu(c); PAIRES.forEach(function (p) { if (p[2] === type) { if (r[p[0]]) s[r[p[0]]] = 1; if (r[p[1]]) s[r[p[1]]] = 1; } }); });
    return Object.keys(s);
  }
  function alternative(fromId) {
    var m = M(fromId);
    if (!m) return null;
    return AV.models.filter(function (x) { return x.type === m.type && x.identifiant !== fromId && x.statut !== 'retire' && x.statut !== 'a_eviter' && x.sante === 'ok' && x.francais !== false; })
      .sort(function (a, b) { return Math.abs(a.prix_minute - m.prix_minute) - Math.abs(b.prix_minute - m.prix_minute); })[0] || null;
  }
  function assurerGroupe() {
    var b = AV.bulk;
    if (b.action === 'replace') {
      var used = modelesUtilises(b.rtype, bulkCibles());
      if (!b.from || !M(b.from) || M(b.from).type !== b.rtype) b.from = used[0] || '';
      if (!b.to || !M(b.to) || M(b.to).type !== b.rtype || b.to === b.from) { var a = b.from ? alternative(b.from) : null; b.to = a ? a.identifiant : ''; }
    }
    if (b.action === 'field' && (!b.fk || b.val === undefined)) { b.fk = b.fk || 'tts_speed'; b.val = clone(BASE[b.fk]); }
  }
  function planifier() {
    var b = AV.bulk, out = [];
    bulkCibles().forEach(function (row) {
      var n = resolu(row), ch = [], np = row.profil;
      if (b.action === 'replace') {
        PAIRES.filter(function (p) { return p[2] === b.rtype; }).forEach(function (p) {
          if (n[p[0]] === b.from) {
            var t = (b.useFb && n[p[1]] && n[p[1]] !== b.from && sante(n[p[1]]) !== 'indisponible') ? n[p[1]] : b.to;
            if (t) { ch.push({ k: p[0], from: n[p[0]], to: t }); n[p[0]] = t; if (b.rtype === 'tts') n.tts_voice_id = ''; }
          }
          if (n[p[1]] === b.from && b.to) { ch.push({ k: p[1], from: n[p[1]], to: b.to }); n[p[1]] = b.to; }
        });
      }
      if (b.action === 'field' && b.fk && !eq(n[b.fk], b.val)) { ch.push({ k: b.fk, from: n[b.fk], to: clone(b.val) }); n[b.fk] = clone(b.val); }
      if (b.action === 'profile') {
        var pc = mkProfil(b.prof);
        CLES_MODELES.forEach(function (k) { if (!eq(n[k], pc[k])) { ch.push({ k: k, from: n[k], to: pc[k] }); n[k] = pc[k]; } });
        if (row.profil !== b.prof || ch.length) np = b.prof;
      }
      if (ch.length) out.push({ row: row, reglages: n, profil: np, ch: ch, avant: coutDe(resolu(row)).total, apres: coutDe(n).total });
    });
    return out;
  }
  function libelleGroupe() {
    var b = AV.bulk;
    if (b.action === 'replace') return 'Remplacer ' + mname(b.from) + (b.useFb ? ' par le modèle de secours' : ' par ' + mname(b.to)) + ' (' + TYPE_LABEL[b.rtype] + ')';
    if (b.action === 'field') return 'Modifier « ' + FM[b.fk].l + ' » → ' + fmtVal(b.fk, b.val);
    return 'Appliquer le profil ' + PROFILS[b.prof].nom;
  }
  function vueGroupee() {
    var b = AV.bulk; assurerGroupe();
    var h = '<button class="av-reset" data-avact="quitter">‹ Agents vocaux</button><h2 style="font-size:19px;margin:6px 0">Modification groupée</h2><div class="av-sub">Prévisualise l\'impact avant d\'appliquer. Chaque agent garde sa version précédente : l\'opération est annulable.</div>';
    h += '<div class="av-card"><b>1. Quels agents ?</b><div class="av-chips"><button class="btn btn-secondary btn-sm" data-avact="bscope" data-id="all">Tous les agents</button></div><div class="av-field"><label class="av-l" for="avf_bulk_scopeModel">Ceux qui utilisent le modèle…</label><select id="avf_bulk_scopeModel" data-avt="bulk" data-avk="scopeModel"><option value="">Choisir…</option>' + AV.models.filter(function (m) { return AV.configs.some(function (c) { var r = resolu(c); return CLES_MODELES.some(function (k) { return r[k] === m.identifiant; }); }); }).map(function (m) { return '<option value="' + esc(m.identifiant) + '">' + esc(m.nom) + '</option>'; }).join('') + '</select></div>';
    AV.configs.forEach(function (c) { h += '<label class="av-check"><input type="checkbox" data-avact="bsel" data-id="' + c.business_id + '"' + (b.ids.indexOf(c.business_id) >= 0 ? ' checked' : '') + '> <span>' + esc(nomBiz(c.business_id)) + '</span> <span class="av-sub">' + esc(mname(resolu(c).llm_model)) + '</span></label>'; });
    h += '</div>';
    h += '<div class="av-card"><b>2. Quelle modification ?</b><div class="av-seg"><button class="' + (b.action === 'replace' ? 'on' : '') + '" data-avact="baction" data-id="replace">Remplacer un modèle</button><button class="' + (b.action === 'field' ? 'on' : '') + '" data-avact="baction" data-id="field">Modifier un réglage</button><button class="' + (b.action === 'profile' ? 'on' : '') + '" data-avact="baction" data-id="profile">Appliquer un profil</button></div>';
    if (b.action === 'replace') {
      var all = AV.models.filter(function (m) { return m.type === b.rtype; });
      h += '<div class="av-field"><label class="av-l" for="avf_bulk_rtype">Type de modèle</label><select id="avf_bulk_rtype" data-avt="bulk" data-avk="rtype">' + ['stt', 'llm', 'tts'].map(function (t) { return '<option value="' + t + '"' + (t === b.rtype ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>'; }).join('') + '</select></div>';
      h += '<div class="av-field"><label class="av-l" for="avf_bulk_from">Modèle à remplacer</label><select id="avf_bulk_from" data-avt="bulk" data-avk="from">' + all.map(function (m) { return '<option value="' + esc(m.identifiant) + '"' + (m.identifiant === b.from ? ' selected' : '') + '>' + esc(m.nom) + (m.sante !== 'ok' ? ' · incident' : '') + '</option>'; }).join('') + '</select></div>';
      h += '<div class="av-field"><label class="av-l" for="avf_bulk_to">Remplacé par</label><select id="avf_bulk_to" data-avt="bulk" data-avk="to">' + all.filter(function (m) { return m.identifiant !== b.from; }).map(function (m) { return '<option value="' + esc(m.identifiant) + '"' + (m.identifiant === b.to ? ' selected' : '') + ((m.sante === 'indisponible' || m.statut === 'retire') ? ' disabled' : '') + '>' + esc(m.nom) + ' — ' + (m.prix_minute != null ? usd(m.prix_minute) + '/min' : 'prix inconnu') + '</option>'; }).join('') + '</select>' + (b.to ? infoModele(b.to) : '') + '</div>';
      h += '<label class="av-check"><input type="checkbox" data-avt="bulk" data-avk="useFb"' + (b.useFb ? ' checked' : '') + '> Utiliser d\'abord le modèle de secours propre à chaque agent</label>';
    }
    if (b.action === 'field') {
      var nm = []; SCHEMA.forEach(function (s) { s.fields.forEach(function (f) { if (!f.locked && !f.col && f.t !== 'model' && f.t !== 'flow' && f.t !== 'info') nm.push(f); }); });
      var f = FM[b.fk];
      h += '<div class="av-field"><label class="av-l" for="avf_bulk_fk">Réglage</label><select id="avf_bulk_fk" data-avt="bulk" data-avk="fk">' + nm.map(function (x) { return '<option value="' + x.k + '"' + (x.k === b.fk ? ' selected' : '') + '>' + esc(x.l) + '</option>'; }).join('') + '</select></div><div class="av-field"><div class="av-top"><label class="av-l" for="avf_bulk_val">Nouvelle valeur</label>' + (f.t === 'range' ? '<b id="avlab_bulk_val">' + f.fmt(b.val) + '</b>' : '') + '</div>' + ctl(Object.assign({}, f, { k: 'val' }), b.val, 'bulk') + '</div>';
    }
    if (b.action === 'profile') h += '<div class="av-field"><label class="av-l" for="avf_bulk_prof">Profil</label><select id="avf_bulk_prof" data-avt="bulk" data-avk="prof">' + Object.keys(PROFILS).map(function (p) { return '<option value="' + p + '"' + (p === b.prof ? ' selected' : '') + '>' + esc(PROFILS[p].nom) + '</option>'; }).join('') + '</select><div class="av-help">Remplace les modèles et modèles de secours. Les autres réglages personnalisés sont conservés.</div></div>';
    h += '</div>';
    var plan = planifier();
    h += '<div class="av-card"><b>3. Aperçu de l\'impact</b>';
    if (!plan.length) h += '<div class="av-sub" style="margin-top:8px">Aucun agent concerné par cette modification.</div>';
    else {
      var sb = 0, sa = 0;
      h += '<table class="av-tbl"><tr><th>Agent</th><th>Changement</th><th>Coût / min</th></tr>';
      plan.forEach(function (p) {
        sb += p.avant; sa += p.apres; var d = p.apres - p.avant;
        h += '<tr><td>' + esc(nomBiz(p.row.business_id)) + '<div class="av-sub">v' + p.row.version + ' → v' + (p.row.version + 1) + '</div></td><td>' + p.ch.map(function (c) { return esc(FM[c.k].l) + ' : ' + esc(fmtVal(c.k, c.from)) + ' → <b>' + esc(fmtVal(c.k, c.to)) + '</b>'; }).join('<br>') + '</td><td>' + usd(p.avant) + ' → ' + usd(p.apres) + '<div class="' + (d > 0.00001 ? 'av-up' : (d < -0.00001 ? 'av-dn' : '')) + '">' + (d > 0 ? '+' : '') + usd(d) + '</div></td></tr>';
      });
      h += '</table><div class="av-kv" style="margin-top:8px"><span>Agents modifiés</span><b>' + plan.length + '</b></div><div class="av-kv"><span>Coût moyen par minute</span><b>' + usd(sb / plan.length) + ' → ' + usd(sa / plan.length) + '</b></div>';
      if (b.action === 'replace' && b.rtype === 'tts') h += '<div class="av-alert warn" style="margin-top:8px">L\'identifiant de voix des agents concernés sera vidé (voix par défaut du nouveau fournisseur). À réécouter avant de continuer.</div>';
    }
    h += '</div><div class="av-card"><b>4. Application</b><label class="av-check"><input type="checkbox" data-avt="bulk" data-avk="canary"' + (b.canary ? ' checked' : '') + '> Appliquer d\'abord à 1 agent, puis continuer depuis l\'historique</label><div class="av-help">Planification de nuit : après la V1.</div></div>';
    h += '<div class="av-row" style="margin-top:12px"><button class="btn btn-secondary" data-avact="quitter">Annuler</button><button class="btn btn-primary" data-avact="bapply"' + (plan.length ? '' : ' disabled') + '>' + (b.canary && plan.length > 1 ? 'Appliquer à 1 agent' : 'Appliquer à ' + plan.length + ' agent(s)') + '</button></div>';
    return h;
  }
  async function executerItems(op, items) {
    var ok = 0, conflits = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.applique || it.annule) continue;
      var r = await supabaseClient.from('agent_config').update({ reglages: it.reglages_apres, profil: it.profil_apres, version: it.version_apres, maj_le: new Date().toISOString() }).eq('business_id', it.business_id).eq('version', it.version_avant).select();
      if (r.error || !r.data || !r.data.length) { it.conflit = true; conflits.push(it.nom); continue; }
      var v = await supabaseClient.from('agent_config_versions').insert({ business_id: it.business_id, version: it.version_apres, profil: it.profil_apres, reglages: it.reglages_apres, motif: 'Opération groupée : ' + op.libelle });
      if (v.error) console.error('Historique de version non enregistré', v.error);
      it.applique = true; it.conflit = false; ok++;
    }
    var tous = op.items.every(function (x) { return x.applique || x.annule; });
    op.statut = tous ? 'appliquee' : 'partielle';
    var u = await supabaseClient.from('operations_groupees').update({ items: op.items, statut: op.statut }).eq('id', op.id);
    if (u.error) console.error(u.error);
    return { ok: ok, conflits: conflits };
  }

  /* ---------- Catalogue ---------- */
  function vueCatalogue() {
    var h = '<div class="options-help">📚 Catalogue des modèles (STT, LLM, TTS) utilisables via LiveKit Inference. Prix relevés le 30/09/2026 sur la grille LiveKit. Le statut est <b>ton avis</b> : aucun modèle n\'a encore été testé. Mise à jour automatique des prix et test de santé nocturne : étape suivante ; en attendant, signale un incident à la main.</div>';
    h += '<div class="av-seg">' + ['stt', 'llm', 'tts'].map(function (t) { return '<button class="' + (AV.catTab === t ? 'on' : '') + '" data-avact="cattab" data-id="' + t + '">' + TYPE_LABEL[t] + '</button>'; }).join('') + '</div>';
    AV.models.filter(function (m) { return m.type === AV.catTab; }).forEach(function (m) {
      var n = AV.configs.filter(function (c) { return primaires(resolu(c)).indexOf(m.identifiant) >= 0; }).length;
      h += '<div class="av-card"><div class="av-row av-between"><div class="av-title">' + esc(m.nom) + (m.hors_catalogue ? ' ' + badge('Hors catalogue', 'warn') : '') + '</div><span class="av-row">' + (m.sante === 'indisponible' ? badge('Indisponible', 'bad') : m.sante === 'lent' ? badge('Latence élevée', 'warn') : '') + '</span></div><div class="av-sub">' + esc(m.fournisseur || '') + ' · <code>' + esc(m.identifiant) + '</code> · utilisé par ' + n + ' agent(s)</div><div class="av-chips"><span class="av-chip">' + (m.prix_minute != null ? usd(m.prix_minute) + ' / min' : 'prix inconnu') + '</span>' + (m.prix_entree_mtok != null ? '<span class="av-chip">entrée ' + usd(m.prix_entree_mtok, 2) + ' · sortie ' + usd(m.prix_sortie_mtok, 2) + ' / M tokens</span>' : '') + badge(m.endpoint_ue ? 'Endpoint UE' : 'Hors UE', m.endpoint_ue ? 'ok' : 'warn') + (m.francais === false ? badge('Sans français', 'bad') : badge('Français', 'ok')) + '<span class="av-chip">Latence : ' + (m.latence_ms ? m.latence_ms + ' ms' : 'non mesurée') + '</span></div>' + (m.note ? '<div class="av-help">' + esc(m.note) + '</div>' : '') +
        '<div class="av-row" style="margin-top:10px"><label class="av-sub" for="avf_st_' + m.id + '">Statut</label><select id="avf_st_' + m.id + '" class="av-in" style="max-width:170px" data-avt="mstatut" data-avk="' + m.id + '">' + Object.keys(STATUTS).map(function (s) { return '<option value="' + s + '"' + (m.statut === s ? ' selected' : '') + '>' + STATUTS[s][0] + '</option>'; }).join('') + '</select><label class="av-sub" for="avf_sa_' + m.id + '">Incident</label><select id="avf_sa_' + m.id + '" class="av-in" style="max-width:190px" data-avt="msante" data-avk="' + m.id + '"><option value="ok"' + (m.sante === 'ok' ? ' selected' : '') + '>Aucun</option><option value="lent"' + (m.sante === 'lent' ? ' selected' : '') + '>Latence élevée</option><option value="indisponible"' + (m.sante === 'indisponible' ? ' selected' : '') + '>Indisponible</option></select>' + (m.hors_catalogue ? '<label class="av-sub" for="avf_px_' + m.id + '">Prix $/min</label><input type="text" id="avf_px_' + m.id + '" class="av-in" style="max-width:110px" data-avt="mprix" data-avk="' + m.id + '" value="' + (m.prix_minute != null ? String(m.prix_minute).replace('.', ',') : '') + '">' : '') + '</div></div>';
    });
    h += '<div class="av-card"><b>Ajouter un modèle hors catalogue</b><div class="av-sub">Pour un modèle tout juste sorti ou absent de la liste. Il est ajouté « non testé ».</div><div class="av-field"><label class="av-l" for="avf_nm_type">Type</label><select id="avf_nm_type" class="av-in" data-avt="nm" data-avk="type">' + ['stt', 'llm', 'tts'].map(function (t) { return '<option value="' + t + '"' + (AV.catTab === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>'; }).join('') + '</select></div><div class="av-field"><label class="av-l" for="avf_nm_id">Identifiant</label><input type="text" id="avf_nm_id" data-avt="nm" data-avk="id" placeholder="fournisseur/modele"></div><div class="av-field"><label class="av-l" for="avf_nm_px">Prix par minute en $ (facultatif)</label><input type="text" id="avf_nm_px" data-avt="nm" data-avk="pm" placeholder="0,0000"></div><button class="btn btn-primary btn-sm" data-avact="addmodel">Ajouter</button></div>';
    return h;
  }

  /* ---------- Prompts ---------- */
  function vuePrompts() {
    var h = '<div class="options-help">📝 Les prompts sont partagés : modifier un prompt ici change immédiatement tous les agents qui l\'utilisent. Le nom d\'un prompt ne se change pas après création (les agents s\'y réfèrent par son nom).</div><div class="sel-toolbar"><button class="btn btn-primary" data-avact="newprompt">➕ Nouveau prompt</button></div>';
    AV.prompts.forEach(function (p) {
      var n = AV.configs.filter(function (c) { return resolu(c).prompt_modele === p.nom; }).length;
      h += '<div class="av-card"><div class="av-row av-between"><div class="av-title">' + esc(p.nom) + ' ' + badge('v' + p.version) + '</div><span class="av-row"><button class="btn btn-secondary btn-sm" data-avact="editprompt" data-id="' + p.id + '">✏️ Modifier</button><button class="btn btn-secondary btn-sm" data-avact="dupprompt" data-id="' + p.id + '">Dupliquer</button></span></div><div class="av-sub">' + esc(p.description || '') + '</div><div class="av-chips">' + (p.contenu && p.contenu.trim() ? badge(p.contenu.length + ' caractères', 'ok') : badge('Vide : à compléter', 'bad')) + '<span class="av-chip">utilisé par ' + n + ' agent(s)</span></div></div>';
    });
    if (!AV.prompts.length) h += '<div class="no-data">Aucun prompt.</div>';
    return h;
  }
  function modalPrompt(p) {
    var neuf = !p;
    var m = $('modal-edit');
    m.innerHTML = '<div class="modal-content av-root" onclick="event.stopPropagation()" style="max-width:760px"><div class="modal-header"><h2>' + (neuf ? '➕ Nouveau prompt' : '✏️ Modifier le prompt') + '</h2><button class="btn-close" onclick="closeModal(\'modal-edit\')">×</button></div><div class="modal-body"><div class="form-group"><label>Nom *</label><input type="text" id="avp-nom" value="' + esc(p ? p.nom : '') + '"' + (neuf ? '' : ' disabled') + '></div><div class="form-group"><label>Description</label><input type="text" id="avp-desc" value="' + esc(p ? (p.description || '') : '') + '"></div><div class="form-group"><label>Contenu du prompt</label><textarea id="avp-contenu" style="min-height:340px;font-family:monospace;font-size:13px">' + esc(p ? p.contenu : '') + '</textarea></div><div class="form-actions"><button class="btn btn-secondary" onclick="closeModal(\'modal-edit\')">Annuler</button><button class="btn btn-primary" data-avact="saveprompt" data-id="' + (p ? p.id : '') + '">💾 Enregistrer</button></div></div></div>';
    m.classList.add('show');
    m.onclick = function () { closeModal('modal-edit'); };
  }

  /* ---------- Historique ---------- */
  function vueHistorique() {
    var h = '<div class="options-help">🕘 Chaque modification groupée peut être annulée : les agents concernés retrouvent leur réglage précédent (enregistré comme une nouvelle version).</div>';
    if (!AV.ops.length) h += '<div class="no-data">Aucune opération pour le moment.</div>';
    AV.ops.forEach(function (op) {
      var st = { appliquee: ['Appliquée', 'ok'], partielle: ['Partielle', 'warn'], planifiee: ['Planifiée', 'info'], annulee: ['Annulée', ''] }[op.statut] || [op.statut, ''];
      var items = op.items || [];
      var restants = items.filter(function (i) { return !i.applique && !i.annule; }).length;
      var appliques = items.filter(function (i) { return i.applique && !i.annule; }).length;
      h += '<div class="av-card"><div class="av-row av-between"><div class="av-title">' + esc(op.libelle) + '</div>' + badge(st[0], st[1]) + '</div><div class="av-sub">' + new Date(op.cree_le).toLocaleString('fr-FR') + ' · ' + items.length + ' agent(s) : ' + items.map(function (i) { return esc(i.nom) + (i.conflit ? ' (modifié entre-temps, ignoré)' : ''); }).join(', ') + '</div><div class="av-row" style="margin-top:8px">' + (restants && op.statut !== 'annulee' ? '<button class="btn btn-primary btn-sm" data-avact="cont" data-id="' + op.id + '">Continuer sur les ' + restants + ' autres</button>' : '') + (appliques ? '<button class="btn btn-secondary btn-sm" data-avact="undo" data-id="' + op.id + '">Annuler (retour arrière)</button>' : '') + '</div></div>';
    });
    return h;
  }

  /* ---------- Saisie ---------- */
  function lireEl(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range') return parseFloat(el.value);
    return el.value;
  }
  function poser(el) {
    var t = el.dataset.avt, k = el.dataset.avk, v = lireEl(el);
    if (t === 'cfg' && el.dataset.avo !== undefined) {
      var arr = (AV.ed.cfg[k] || []).slice(), o = el.dataset.avo, i = arr.indexOf(o);
      if (el.checked && i < 0) arr.push(o); if (!el.checked && i >= 0) arr.splice(i, 1);
      AV.ed.cfg[k] = arr; return;
    }
    if (t === 'cfg') {
      if (v === '__custom__' && FM[k] && FM[k].t === 'model') { AV.ed.custom = { k: k, type: FM[k].mt, id: '', pm: '' }; return; }
      if (FM[k] && FM[k].num && v !== '') v = parseFloat(v);
      AV.ed.cfg[k] = v;
    } else if (t === 'flow') AV.ed.cfg.flow[parseInt(k, 10)][el.dataset.avp] = v;
    else if (t === 'custom') AV.ed.custom[k] = v;
    else if (t === 'ed') { AV.ed[k] = v; if (k === 'bid') AV.ed.menu = undefined; }
    else if (t === 'nm') { AV.nm = AV.nm || {}; AV.nm[k] = v; }
    else if (t === 'bulk') {
      if (k === 'scopeModel') { if (v) AV.bulk.ids = AV.configs.filter(function (c) { var r = resolu(c); return CLES_MODELES.some(function (x) { return r[x] === v; }); }).map(function (c) { return c.business_id; }); return; }
      if (el.dataset.avo !== undefined) return;
      var ff = k === 'val' && FM[AV.bulk.fk];
      if (ff && ff.num && v !== '') v = parseFloat(v);
      AV.bulk[k] = v;
      if (k === 'rtype') { AV.bulk.from = ''; AV.bulk.to = ''; }
      if (k === 'from') AV.bulk.to = '';
      if (k === 'fk') AV.bulk.val = clone(BASE[v]);
    }
  }

  /* ---------- Actions ---------- */
  var A = {};
  var run = function (fn) { return Promise.resolve().then(fn).catch(function (err) { console.error(err); alert('❌ ' + (err && err.message ? err.message : err)); }); };

  A.quitter = function () { AV.ed = null; AV.bulk = null; rendre(); };
  A.filtre = function (el) { AV.filter = el.dataset.id; AV.modelFilter = ''; rendre(); };
  A.fmodel = function (el) { AV.modelFilter = el.dataset.id; rendre(); };
  A.selall = function () { AV.configs.forEach(function (c) { AV.sel[c.business_id] = true; }); rendre(); };
  A.selnone = function () { AV.sel = {}; rendre(); };
  A.sel = function (el) { AV.sel[el.dataset.id] = el.checked; rendre(); };
  A.groupe = function () {
    var ids = Object.keys(AV.sel).filter(function (k) { return AV.sel[k] && cfgOf(k); });
    AV.bulk = { ids: ids, action: 'replace', rtype: 'llm', from: '', to: '', useFb: false, canary: false, prof: 'equilibre' }; rendre();
  };
  A.urgence = function (el) {
    var m = M(el.dataset.id);
    var ids = AV.configs.filter(function (c) { return primaires(resolu(c)).indexOf(m.identifiant) >= 0; }).map(function (c) { return c.business_id; });
    AV.bulk = { ids: ids, action: 'replace', rtype: m.type, from: m.identifiant, to: '', useFb: true, canary: false, prof: 'equilibre' }; rendre();
  };
  A.bscope = function () { AV.bulk.ids = AV.configs.map(function (c) { return c.business_id; }); rendre(); };
  A.bsel = function (el) { var i = AV.bulk.ids.indexOf(el.dataset.id); if (el.checked && i < 0) AV.bulk.ids.push(el.dataset.id); if (!el.checked && i >= 0) AV.bulk.ids.splice(i, 1); rendre(); };
  A.baction = function (el) { AV.bulk.action = el.dataset.id; if (el.dataset.id === 'field') { AV.bulk.fk = ''; AV.bulk.val = undefined; } rendre(); };
  A.bapply = function () {
    return run(async function () {
      var plan = planifier(); if (!plan.length) return;
      var b = AV.bulk;
      if (!confirm('Appliquer « ' + libelleGroupe() + ' » à ' + (b.canary && plan.length > 1 ? '1 agent (test)' : plan.length + ' agent(s)') + ' ?')) return;
      var items = plan.map(function (p) { return { business_id: p.row.business_id, nom: nomBiz(p.row.business_id), version_avant: p.row.version, profil_avant: p.row.profil, reglages_avant: clone(p.row.reglages || {}), version_apres: p.row.version + 1, profil_apres: p.profil, reglages_apres: p.reglages, applique: false, annule: false }; });
      var ins = await supabaseClient.from('operations_groupees').insert({ libelle: libelleGroupe(), statut: 'partielle', items: items }).select().single();
      if (ins.error) throw ins.error;
      var op = ins.data;
      var cible = b.canary && items.length > 1 ? [op.items[0]] : op.items;
      var res = await executerItems(op, cible);
      AV.sel = {}; AV.bulk = null;
      await charger(); rendre();
      alert('✅ ' + res.ok + ' agent(s) modifié(s)' + (res.conflits.length ? '\n⚠️ Ignorés (modifiés entre-temps) : ' + res.conflits.join(', ') : '') + (b.canary && items.length > 1 ? '\nVérifie, puis « Continuer » depuis Modifications groupées.' : ''));
    });
  };
  A.cont = function (el) {
    return run(async function () {
      var op = AV.ops.find(function (o) { return o.id === el.dataset.id; }); if (!op) return;
      var res = await executerItems(op, op.items);
      await charger(); rendre();
      alert('✅ ' + res.ok + ' agent(s) modifié(s)' + (res.conflits.length ? '\n⚠️ Ignorés (modifiés entre-temps) : ' + res.conflits.join(', ') : ''));
    });
  };
  A.undo = function (el) {
    return run(async function () {
      var op = AV.ops.find(function (o) { return o.id === el.dataset.id; }); if (!op) return;
      if (!confirm('Annuler « ' + op.libelle + ' » ? Les agents retrouvent leur réglage précédent.')) return;
      var ok = 0, ignores = [];
      for (var i = 0; i < op.items.length; i++) {
        var it = op.items[i];
        if (!it.applique || it.annule) continue;
        var cur = await supabaseClient.from('agent_config').select('*').eq('business_id', it.business_id).single();
        if (cur.error || !cur.data || cur.data.version !== it.version_apres) { ignores.push(it.nom); continue; }
        var v2 = cur.data.version + 1;
        var up = await supabaseClient.from('agent_config').update({ reglages: it.reglages_avant, profil: it.profil_avant, version: v2, maj_le: new Date().toISOString() }).eq('business_id', it.business_id).eq('version', cur.data.version).select();
        if (up.error || !up.data || !up.data.length) { ignores.push(it.nom); continue; }
        await supabaseClient.from('agent_config_versions').insert({ business_id: it.business_id, version: v2, profil: it.profil_avant, reglages: it.reglages_avant, motif: 'Annulation de : ' + op.libelle });
        it.annule = true; ok++;
      }
      var actifs = op.items.filter(function (x) { return x.applique && !x.annule; }).length;
      op.statut = actifs === 0 ? 'annulee' : 'partielle';
      await supabaseClient.from('operations_groupees').update({ items: op.items, statut: op.statut }).eq('id', op.id);
      await charger(); rendre();
      alert('✅ ' + ok + ' agent(s) restauré(s)' + (ignores.length ? '\n⚠️ Modifiés depuis cette opération, laissés tels quels : ' + ignores.join(', ') : ''));
    });
  };

  A.creer = function (el) {
    var bid = el ? el.dataset.id : '';
    AV.ed = { mode: 'create', step: bid ? 2 : 1, bid: bid || '', profil: 'equilibre', cfg: Object.assign(mkProfil('equilibre'), { numero_twilio: '', numero_public: '' }), copied: '', testOk: false, custom: null };
    if (bid) A.recompter(); rendre();
  };
  A.editer = function (el) {
    var row = cfgOf(el.dataset.id); if (!row) return;
    AV.ed = { mode: 'edit', bid: row.business_id, name: nomBiz(row.business_id), row: row, profil: row.profil, version: row.version, cfg: aplatir(row), orig: aplatir(row), showDiff: false, custom: null };
    rendre();
  };
  A.service = function (el) {
    return run(async function () {
      var row = cfgOf(el.dataset.id); if (!row) return;
      var vers = !row.actif;
      if (!confirm((vers ? 'Mettre en service' : 'Retirer du service') + ' l\'agent de ' + nomBiz(row.business_id) + ' ?')) return;
      var r = await supabaseClient.from('agent_config').update({ actif: vers, maj_le: new Date().toISOString() }).eq('id', row.id);
      if (r.error) throw r.error;
      await charger(); rendre();
    });
  };
  A.sec = function (el) { AV.openSec[el.dataset.id] = !AV.openSec[el.dataset.id]; rendre(); };
  A.adv = function (el) { AV.showAdv = el.checked; rendre(); };
  A.reset = function (el) { var k = el.dataset.id; AV.ed.cfg[k] = clone(mkProfil(AV.ed.profil)[k]); rendre(); };
  A.diff = function () { AV.ed.showDiff = !AV.ed.showDiff; rendre(); };
  A.etape = function (el) {
    var n = parseInt(el.dataset.id, 10); if (!(n >= 1 && n <= 6)) return;
    if (n > 1 && !AV.ed.bid) { alert('Choisis d\'abord un restaurant.'); return; }
    AV.ed.step = n;
    if (n === 2 || n === 6) A.recompter();
    rendre();
  };
  A.prof = function (el) { AV.ed.profil = el.dataset.id; var keep = { numero_twilio: AV.ed.cfg.numero_twilio, numero_public: AV.ed.cfg.numero_public }; AV.ed.cfg = Object.assign(mkProfil(el.dataset.id), keep); AV.ed.copied = ''; rendre(); };
  A.copy = function (el) {
    var row = cfgOf(el.value); if (!row) return;
    var keep = { numero_twilio: AV.ed.cfg.numero_twilio, numero_public: AV.ed.cfg.numero_public };
    AV.ed.cfg = Object.assign(resolu(row), keep); AV.ed.profil = PROFILS[row.profil] ? row.profil : 'equilibre'; AV.ed.copied = nomBiz(row.business_id); rendre();
  };
  A.newbiz = function () { if (typeof openAddBusinessModal === 'function') openAddBusinessModal(); };
  A.recompter = function () {
    var e = AV.ed; if (!e || !e.bid) return;
    var bid = e.bid;
    var compter = async function (table, extra) {
      var q = supabaseClient.from(table).select('id', { count: 'exact', head: true }).eq('business_id', bid);
      Object.keys(extra || {}).forEach(function (k) { q = q.eq(k, extra[k]); });
      var r = await q; return r.error ? null : (r.count || 0);
    };
    return Promise.all([compter('produits'), compter('zones_service'), compter('business_horaires', { est_ouvert: true }), compter('regles_categorie', { actif: true })]).then(function (r) {
      if (AV.ed && AV.ed.bid === bid) { AV.ed.menu = { produits: r[0], zones: r[1], horaires: r[2], regles: r[3] }; rendre(); }
    });
  };
  A.aller = function (el) {
    return run(async function () {
      var bid = AV.ed && AV.ed.bid;
      if (bid && typeof BUSINESS_ID !== 'undefined' && bid !== BUSINESS_ID && typeof onChangeBusiness === 'function') {
        var sel = $('business-selector'); if (sel) sel.value = bid;
        await onChangeBusiness(bid);
      }
      allerSection(el.dataset.id);
    });
  };
  A.create = function () {
    return run(async function () {
      var e = AV.ed;
      if (!e.bid) { alert('Choisis un restaurant.'); return; }
      var pb = verifOptions(e.cfg); if (pb) { alert('⚠️ ' + pb); return; }
      var reglages = clone(e.cfg); delete reglages.numero_twilio; delete reglages.numero_public;
      var ins = await supabaseClient.from('agent_config').insert({ business_id: e.bid, moteur: 'livekit', profil: e.profil, version: 1, reglages: reglages, numero_twilio: (e.cfg.numero_twilio || '').trim() || null, numero_public: (e.cfg.numero_public || '').trim() || null, actif: false }).select().single();
      if (ins.error) throw ins.error;
      await supabaseClient.from('agent_config_versions').insert({ business_id: e.bid, version: 1, profil: e.profil, reglages: reglages, motif: 'Création' });
      AV.ed = null; await charger(); rendre();
      alert('✅ Agent créé (hors service). Après ton test d\'appel, mets-le en service depuis la liste.');
    });
  };
  function verifOptions(c) {
    if (c.tool_transfer && !String(c.transfer_num || '').trim()) return 'Renseigne le numéro de transfert, ou désactive le transfert vers un humain.';
    if (c.tool_sms && !/^[A-Za-z0-9 ]{1,11}$/.test(String(c.sms_sender || '').trim())) return 'Renseigne un nom d\'expéditeur de SMS valide (11 caractères maximum, lettres et chiffres), ou désactive le SMS.';
    return '';
  }
  A.save = function () {
    return run(async function () {
      var e = AV.ed, n = changements(); if (!n.length) return;
      var pb = verifOptions(e.cfg); if (pb) { alert('⚠️ ' + pb); return; }
      var motif = window.prompt('Motif de cette modification (facultatif) :', '');
      if (motif === null) return;
      var reglages = clone(e.cfg); delete reglages.numero_twilio; delete reglages.numero_public;
      var v2 = e.version + 1;
      var r = await supabaseClient.from('agent_config').update({ reglages: reglages, numero_twilio: (e.cfg.numero_twilio || '').trim() || null, numero_public: (e.cfg.numero_public || '').trim() || null, version: v2, maj_le: new Date().toISOString() }).eq('id', e.row.id).eq('version', e.version).select();
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) { alert('⚠️ Cet agent a été modifié entre-temps (autre écran ou modification groupée). Rien n\'a été enregistré : recharge la page et refais tes changements.'); return; }
      var v = await supabaseClient.from('agent_config_versions').insert({ business_id: e.bid, version: v2, profil: e.profil, reglages: reglages, motif: motif || (n.length + ' modification(s)') });
      if (v.error) console.error('Historique non enregistré', v.error);
      AV.ed = null; await charger(); rendre();
      alert('✅ Version v' + v2 + ' enregistrée. Active dès le prochain appel.');
    });
  };
  A.addcustom = function () {
    return run(async function () {
      var c = AV.ed.custom, id = (c.id || '').trim();
      if (!id) { alert('Saisis un identifiant de modèle.'); return; }
      var pm = parseFloat(String(c.pm).replace(',', '.'));
      var ex = M(id);
      if (!ex) {
        var r = await supabaseClient.from('catalogue_modeles').insert({ type: c.type, identifiant: id, nom: id, fournisseur: 'Hors catalogue', prix_minute: isNaN(pm) ? null : pm, francais: true, endpoint_ue: false, hors_catalogue: true, statut: 'non_teste', note: 'Ajouté à la main : à vérifier' }).select().single();
        if (r.error) throw r.error;
        AV.models.push(r.data);
      }
      AV.ed.cfg[c.k] = id; AV.ed.custom = null; rendre();
      alert('Modèle ajouté, non testé.');
    });
  };
  A.cancelcustom = function () { AV.ed.custom = null; rendre(); };

  A.cattab = function (el) { AV.catTab = el.dataset.id; rendre(); };
  A.addmodel = function () {
    return run(async function () {
      var nm = AV.nm || {}, id = (nm.id || '').trim();
      if (!id) { alert('Saisis un identifiant.'); return; }
      if (M(id)) { alert('Ce modèle existe déjà dans le catalogue.'); return; }
      var pm = parseFloat(String(nm.pm || '').replace(',', '.'));
      var type = nm.type || AV.catTab;
      var r = await supabaseClient.from('catalogue_modeles').insert({ type: type, identifiant: id, nom: id, fournisseur: 'Hors catalogue', prix_minute: isNaN(pm) ? null : pm, hors_catalogue: true, statut: 'non_teste', endpoint_ue: false, francais: true, note: 'Ajouté à la main : à vérifier' }).select().single();
      if (r.error) throw r.error;
      AV.models.push(r.data); AV.nm = {}; AV.catTab = type; rendre();
    });
  };
  A.newprompt = function () { modalPrompt(null); };
  A.editprompt = function (el) { modalPrompt(AV.prompts.find(function (p) { return p.id === el.dataset.id; })); };
  A.dupprompt = function (el) {
    return run(async function () {
      var p = AV.prompts.find(function (x) { return x.id === el.dataset.id; }); if (!p) return;
      var nom = window.prompt('Nom du nouveau prompt :', p.nom + ' (copie)'); if (!nom) return;
      var r = await supabaseClient.from('agent_prompts').insert({ nom: nom.trim(), description: p.description, contenu: p.contenu }).select().single();
      if (r.error) throw r.error;
      await charger(); rendre();
    });
  };
  A.saveprompt = function (el) {
    return run(async function () {
      var id = el.dataset.id, nom = $('avp-nom').value.trim(), desc = $('avp-desc').value.trim(), contenu = $('avp-contenu').value;
      if (!nom) { alert('Le nom est obligatoire.'); return; }
      if (!id) {
        var ins = await supabaseClient.from('agent_prompts').insert({ nom: nom, description: desc || null, contenu: contenu }).select().single();
        if (ins.error) throw ins.error;
      } else {
        var p = AV.prompts.find(function (x) { return x.id === id; });
        var up = await supabaseClient.from('agent_prompts').update({ description: desc || null, contenu: contenu, version: (p ? p.version : 1) + 1, maj_le: new Date().toISOString() }).eq('id', id);
        if (up.error) throw up.error;
      }
      closeModal('modal-edit'); await charger(); rendre();
      alert('✅ Prompt enregistré');
    });
  };

  /* ---------- Événements ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-avact]') : null;
    if (!el || !el.closest('.av-root')) return;
    if ((el.tagName === 'INPUT' && el.type !== 'radio') || el.tagName === 'SELECT') return;
    if (el.tagName === 'INPUT') return;
    var f = A[el.dataset.avact]; if (f) f(el);
  }, true); // phase de capture : les fenêtres du back-office arrêtent la propagation des clics
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el.dataset || !el.dataset.avt || !el.closest('.av-root')) return;
    if (el.type === 'range') {
      poser(el);
      var t = el.dataset.avt, k = el.dataset.avk;
      var fld = t === 'bulk' ? FM[AV.bulk && AV.bulk.fk] : FM[k];
      var lab = $('avlab_' + t + '_' + k);
      if (lab && fld) lab.textContent = fld.fmt(parseFloat(el.value));
      var bar = $('avbar'); if (bar && AV.ed) bar.innerHTML = barre();
    } else if (el.type === 'text' || el.tagName === 'TEXTAREA') {
      poser(el);
      var bar2 = $('avbar'); if (bar2 && AV.ed) bar2.innerHTML = barre();
    }
  });
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el.closest || !el.closest('.av-root')) return;
    if (el.dataset.avact === 'copy') { A.copy(el); return; }
    if (el.dataset.avact === 'prof') { A.prof(el); return; }
    if (el.dataset.avact === 'sel') { A.sel(el); return; }
    if (el.dataset.avact === 'adv') { A.adv(el); return; }
    if (el.dataset.avact === 'bsel') { A.bsel(el); return; }
    var t = el.dataset.avt; if (!t) return;
    if (t === 'mstatut' || t === 'msante' || t === 'mprix') {
      run(async function () {
        var m = AV.models.find(function (x) { return x.id === el.dataset.avk; }); if (!m) return;
        var patch = { maj_le: new Date().toISOString() };
        if (t === 'mstatut') patch.statut = el.value;
        if (t === 'msante') patch.sante = el.value;
        if (t === 'mprix') { var pm = parseFloat(String(el.value).replace(',', '.')); patch.prix_minute = isNaN(pm) ? null : pm; }
        var r = await supabaseClient.from('catalogue_modeles').update(patch).eq('id', m.id);
        if (r.error) throw r.error;
        Object.assign(m, patch); rendre();
      });
      return;
    }
    if (t === 'nm' || t === 'custom' || el.type === 'text' || el.type === 'password' || el.tagName === 'TEXTAREA') { poser(el); var b = $('avbar'); if (b && AV.ed) b.innerHTML = barre(); return; }
    poser(el);
    if (t === 'ed' && el.dataset.avk === 'bid') { A.recompter(); }
    rendre();
  });

  window.AgentVocal = { version: '3.2', etat: AV };
})();

/* =====================================================================
   Module « Journal d'appel » — ajoute des informations aux appels LiveKit
   SANS modifier l'existant : les fonctions renderEvenements et
   openEvenementDetail sont simplement enveloppées ; le Journal fait d'abord
   exactement ce qu'il faisait, puis on ajoute :
     - une pastille du moteur (LiveKit / appel plus ancien) sur chaque appel,
     - la latence de réponse dans la ligne des appels LiveKit,
     - un bandeau de moyennes (coût par appel, latences) sous les totaux,
     - un bloc « Panier de l'appel » (articles, informations, chronologie),
     - un bloc « Détail technique » dans le détail d'un appel LiveKit.
   Tables lues : appels_livekit (voir agent_vocal_etape2_appels.sql),
   panier_commandes, panier_lignes, panier_journal (Agent V2).
   ===================================================================== */
(function () {
  'use strict';
  if (window.__agentVocalJournal) return;
  if (typeof window.renderEvenements !== 'function' || typeof window.openEvenementDetail !== 'function' ||
      typeof supabaseClient === 'undefined') {
    console.warn('[agent-vocal] module Journal non chargé (page inattendue)');
    return;
  }
  window.__agentVocalJournal = true;

  var cache = {};            // conversation_id -> ligne appels_livekit (ou null si absente)
  var tableAbsente = false;
  var enCours = false;

  var esc = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var fs = function (x) { return x == null ? '—' : Number(x).toFixed(2).replace('.', ',') + ' s'; };
  var fu = function (x, d) { return x == null ? '—' : Number(x).toFixed(d == null ? 4 : d).replace('.', ',') + ' $'; };
  var fe = function (x) { return x == null ? '—' : Number(x).toFixed(2).replace('.', ',') + ' €'; };
  var estLiveKit = function (evt) { return !!evt && typeof evt.call_id === 'string' && evt.call_id.indexOf('lk_') === 0; };
  var liste = function () { try { return (typeof evenements !== 'undefined' && Array.isArray(evenements)) ? evenements : []; } catch (e) { return []; } };
  var obj = function (v) { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return {}; } } return v || {}; };

  function pastille(evt) {
    return estLiveKit(evt)
      ? '<span class="av-moteur" style="display:inline-block;padding:2px 8px;border-radius:6px;background:#e7f1f8;color:#1f5f8b;font-size:11px;font-weight:700;">LiveKit</span>'
      : '<span class="av-moteur" style="display:inline-block;padding:2px 8px;border-radius:6px;background:#eceef1;color:#5b6470;font-size:11px;font-weight:700;">Ancien</span>';
  }

  async function charger(ids) {
    var manquants = ids.filter(function (id) { return !(id in cache); });
    if (!manquants.length || tableAbsente) return false;
    try {
      var r = await supabaseClient.from('appels_livekit').select('*').in('conversation_id', manquants);
      if (r.error) { if (r.error.code === '42P01' || /does not exist|schema cache/i.test(r.error.message || '')) tableAbsente = true; throw r.error; }
      manquants.forEach(function (id) { cache[id] = null; });
      (r.data || []).forEach(function (l) { cache[l.conversation_id] = l; });
      return true;
    } catch (e) {
      console.warn('[agent-vocal] mesures LiveKit indisponibles :', e && e.message);
      manquants.forEach(function (id) { cache[id] = null; });
      return false;
    }
  }

  function moyenne(tab) { return tab.length ? tab.reduce(function (s, x) { return s + x; }, 0) / tab.length : null; }

  function comparatif(lignes) {
    function groupe(cle, titre) {
      var g = {};
      lignes.forEach(function (l) { var m = obj(l.modeles)[cle]; if (m) { (g[m] = g[m] || []).push(l); } });
      var noms = Object.keys(g).sort();
      if (!noms.length) return '';
      var moy = function (ls, champ) {
        return moyenne(ls.map(function (l) { var st = obj(l.latences)[champ]; return st ? Number(st.moyenne) : null; }).filter(function (x) { return x > 0; }));
      };
      var th = '<tr style="text-align:left;color:#666;"><th style="padding:4px 8px;">Modèle</th><th style="padding:4px 8px;">Appels</th><th style="padding:4px 8px;">Réponse</th><th style="padding:4px 8px;">1er mot cerveau</th><th style="padding:4px 8px;">1er son voix</th><th style="padding:4px 8px;">Coût moyen</th></tr>';
      var rows = noms.map(function (nom) {
        var ls = g[nom];
        var cm = moyenne(ls.map(function (l) { return Number(obj(l.cout).total_usd); }).filter(function (x) { return x > 0; }));
        return '<tr><td style="padding:4px 8px;">' + esc(nom) + '</td><td style="padding:4px 8px;">' + ls.length + '</td><td style="padding:4px 8px;">' + fs(moy(ls, 'reponse')) + '</td><td style="padding:4px 8px;">' + fs(moy(ls, 'cerveau_premier_mot')) + '</td><td style="padding:4px 8px;">' + fs(moy(ls, 'voix_premier_son')) + '</td><td style="padding:4px 8px;">' + fu(cm, 3) + '</td></tr>';
      }).join('');
      return '<div style="margin-top:10px;font-weight:700;font-size:13px;">' + esc(titre) + '</div><table style="border-collapse:collapse;font-size:13px;width:100%;">' + th + rows + '</table>';
    }
    return '<details style="width:100%;margin-top:4px;"><summary style="cursor:pointer;font-size:13px;color:#1f5f8b;">Comparer les modèles utilisés (cerveau, voix, écoute)</summary>' +
      groupe('llm', 'Cerveau') + groupe('tts', 'Voix') + groupe('stt', 'Écoute') +
      '<div style="font-size:11px;color:#999;margin-top:6px;">Pour une comparaison juste : changer un seul réglage à la fois, avec au moins 3 appels de même type par réglage.</div></details>';
  }

  function bandeau(lignes) {
    var recap = document.getElementById('logs-recap');
    var conteneur = document.getElementById('logs-content');
    var cible = recap || conteneur;
    if (!cible || !cible.parentNode) return;
    var el = document.getElementById('av-journal-resume');
    if (!lignes.length) { if (el) el.remove(); return; }
    var couts = lignes.map(function (l) { return Number(obj(l.cout).total_usd); }).filter(function (x) { return x > 0; });
    var rep = lignes.map(function (l) { var m = obj(l.latences).reponse; return m ? Number(m.moyenne) : null; }).filter(function (x) { return x > 0; });
    var cer = lignes.map(function (l) { var m = obj(l.latences).cerveau_premier_mot; return m ? Number(m.moyenne) : null; }).filter(function (x) { return x > 0; });
    var voi = lignes.map(function (l) { var m = obj(l.latences).voix_premier_son; return m ? Number(m.moyenne) : null; }).filter(function (x) { return x > 0; });
    var dem = lignes.map(function (l) { var d = obj(l.demarrage); return d.total_avant_accueil_s != null ? Number(d.total_avant_accueil_s) : null; }).filter(function (x) { return x > 0; });
    var cartes = [
      ['Appels LiveKit affichés', String(lignes.length)],
      ['Coût moyen par appel', fu(moyenne(couts), 3)],
      ['Réponse (fin de parole → voix)', fs(moyenne(rep))],
      ['Premier mot du cerveau', fs(moyenne(cer))],
      ['Premier son de la voix', fs(moyenne(voi))],
      ['Démarrage avant accueil', fs(moyenne(dem))]
    ];
    var html = '<div style="font-size:12px;color:var(--muted,#6b7480);width:100%;">Moyennes sur les appels LiveKit affichés ci-dessous (estimation de coût d\'après les prix du catalogue)</div>' +
      cartes.map(function (c) {
        return '<div class="recap-card"><div class="recap-label">' + esc(c[0]) + '</div><div class="recap-value" style="font-size:18px;">' + esc(c[1]) + '</div></div>';
      }).join('') + comparatif(lignes);
    if (!el) {
      el = document.createElement('div');
      el.id = 'av-journal-resume';
      el.className = 'recap-bar';
      el.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin:0 0 12px;';
      cible.parentNode.insertBefore(el, recap ? recap.nextSibling : conteneur);
    }
    el.innerHTML = html;
  }

  async function decorer() {
    if (enCours) return;
    enCours = true;
    try {
      var evts = liste();
      var conteneur = document.getElementById('logs-content');
      if (!conteneur || !evts.length) { bandeau([]); return; }
      var ids = evts.filter(estLiveKit).map(function (e) { return e.call_id; });
      await charger(ids);
      var parId = {};
      evts.forEach(function (e) { parId[String(e.id)] = e; });
      conteneur.querySelectorAll('.row-item').forEach(function (row) {
        var m = /openEvenementDetail\('([^']+)'\)/.exec(row.getAttribute('onclick') || '');
        var evt = m ? parId[m[1]] : null;
        if (!evt || row.querySelector('.av-moteur')) return;
        var droite = row.querySelector('.row-right');
        if (droite) droite.insertAdjacentHTML('afterbegin', pastille(evt));
        if (estLiveKit(evt) && cache[evt.call_id]) {
          var rep = obj(cache[evt.call_id].latences).reponse;
          var sub = row.querySelector('.row-sub');
          if (rep && sub) sub.insertAdjacentHTML('beforeend', ' • ⚡ ' + fs(rep.moyenne));
        }
      });
      bandeau(ids.map(function (id) { return cache[id]; }).filter(Boolean));
    } catch (e) {
      console.warn('[agent-vocal] Journal : décoration impossible', e);
    } finally {
      enCours = false;
    }
  }

  function bloc(titre, corps) {
    return '<div style="margin-top:12px;"><div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#666;margin-bottom:4px;">' + esc(titre) + '</div>' + corps + '</div>';
  }
  function ligne(a, b, fort) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;font-size:14px;padding:2px 0;' + (fort ? 'font-weight:700;border-top:1px solid #ddd;margin-top:4px;padding-top:6px;' : '') + '"><span>' + esc(a) + '</span><span>' + esc(b) + '</span></div>';
  }
  function stat(l, nom) { var s = obj(l.latences)[nom]; return s ? fs(s.moyenne) + ' (médiane ' + fs(s.mediane) + ', max ' + fs(s.max) + ', ' + s.n + ' tours)' : '—'; }

  function blocDetail(l) {
    var m = obj(l.modeles), rg = m.reglages || {}, d = obj(l.demarrage), c = obj(l.cout), res = obj(l.resultat), t = c.tokens || {};
    var chips = ['stt', 'llm', 'tts'].map(function (k) {
      return m[k] ? '<span style="display:inline-block;padding:2px 8px;margin:2px 4px 2px 0;border-radius:6px;background:#eceef1;font-size:12px;">' + esc(m[k]) + '</span>' : '';
    }).join('');
    var reg = [];
    if (rg.source) reg.push('réglages : ' + rg.source);
    if (rg.vitesse != null) reg.push('vitesse ' + String(rg.vitesse).replace('.', ',') + '×');
    if (rg.expressif != null) reg.push('mode expressif ' + (rg.expressif ? 'oui' : 'non'));
    if (rg.attente_min) reg.push('attente min. ' + rg.attente_min);
    if (rg.bruit != null) reg.push('suppression de bruit ' + (rg.bruit ? ('oui' + (rg.bruit_modele ? ' (' + rg.bruit_modele + ')' : '')) : 'non'));
    if (rg.seuil_voix != null) reg.push('seuil de voix ' + String(rg.seuil_voix).replace('.', ','));
    var tours = (obj(l.latences).tours || []).filter(function (x) { return x.role === 'assistant' && x.e2e_latency; });
    var detailTours = tours.length
      ? '<details style="margin-top:8px;"><summary style="cursor:pointer;font-size:13px;color:#1f5f8b;">Détail par réponse de l\'agent</summary>' +
        tours.map(function (x, i) {
          return ligne('Réponse ' + (i + 1), fs(x.e2e_latency) + ' (cerveau ' + fs(x.llm_node_ttft) + ' · voix ' + fs(x.tts_node_ttfb) + ')');
        }).join('') + '</details>'
      : '';
    var secoursHtml = (m.secours || []).map(function (x) {
      var nom = { stt: 'écoute', llm: 'cerveau', tts: 'voix' }[x.type] || x.type;
      return '<div style="font-size:13px;color:#b26a00;margin-top:6px;">⚠️ Modèle de secours utilisé pour ' + esc(nom) + ' : demandé ' + esc(x.demande) + ', utilisé ' + esc(x.utilise) + '. Les mesures de cet appel concernent le modèle utilisé.</div>';
    }).join('');
    var anomalies = (res.anomalies || []).map(function (a) { return '<div style="font-size:13px;color:#f57c00;">⚠️ ' + esc(a && a.message ? a.message : a) + '</div>'; }).join('');
    return '<div class="av-detail-technique" style="background:#f8f9fa;padding:16px;border-radius:8px;margin-bottom:16px;border-left:4px solid #1f5f8b;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;"><strong>⚡ Détail technique</strong>' + pastille({ call_id: 'lk_' }) + '</div>' +
      '<div style="margin-top:8px;">' + chips + '</div>' +
      (reg.length ? '<div style="font-size:12px;color:#666;">' + esc(reg.join(' · ')) + '</div>' : '') +
      secoursHtml +
      bloc('Démarrage', ligne('Connexion', fs(d.connexion_s)) + ligne('preCallWebhook', fs(d.precall_s)) + ligne('Démarrage de la session', fs(d.session_s)) + ligne('Total avant l\'accueil', fs(d.total_avant_accueil_s), true)) +
      bloc('Latence', ligne('Réponse (fin de parole → voix)', stat(l, 'reponse')) + ligne('Premier mot du cerveau', stat(l, 'cerveau_premier_mot')) + ligne('Premier son de la voix', stat(l, 'voix_premier_son')) + ligne('Attente de fin de parole', stat(l, 'fin_de_parole')) + detailTours) +
      bloc('Coût estimé', ligne('Écoute', fu(c.ecoute)) + ligne('Cerveau (' + (t.entree || 0) + ' tokens lus' + (t.entree_cache ? ', dont ' + t.entree_cache + ' en cache' : ', aucun en cache') + ', ' + (t.sortie || 0) + ' écrits)', fu(c.cerveau)) + ligne('Voix (' + (c.voix_caracteres || 0) + ' caractères)', fu(c.voix)) + ligne('Analyse de fin d\'appel', fu(c.analyse)) + ligne('LiveKit (agent)', fu(c.livekit_agent)) + ligne('Pont Twilio-LiveKit', fu(c.pont)) + ligne('Twilio', fu(c.twilio)) + ligne('Total', fu(c.total_usd), true) +
        '<div style="font-size:11px;color:#999;margin-top:4px;">' + esc(c.note || '') + (c.inconnus && c.inconnus.length ? ' Prix inconnu pour : ' + esc(c.inconnus.join(', ')) + '.' : '') + '</div>') +
      bloc('Résultat de la commande', ligne('Statut', res.statut || '—') + ligne('Numéro de commande', res.numero_commande || 'aucune commande créée') + anomalies) +
      '</div>';
  }

  /* ---------- Panier de l'appel (Agent V2) ---------- */
  var ACTIONS_PANIER = {
    ouverture: 'Panier ouvert', reprise: 'Panier repris', abandon: 'Panier abandonné', reouverture: 'Panier rouvert',
    ajout: 'Ajout', modification: 'Modification', retrait: 'Retrait', infos: 'Informations', validation: 'Validation',
    fin_appel: 'Fin d\'appel', supplement_a_confirmer: 'Prix à confirmer', choix_refuse: 'Choix refusé',
    produit_introuvable: 'Produit introuvable', produit_ambigu: 'Produit ambigu', retrait_ambigu: 'Retrait : plusieurs lignes',
    retrait_introuvable: 'Retrait : ligne introuvable', modif_ambigue: 'Modification : plusieurs lignes',
    modif_introuvable: 'Modification : ligne introuvable', minimum_livraison: 'Minimum de livraison',
    validation_infos_manquantes: 'Validation : informations manquantes', validation_refusee: 'Validation refusée',
    erreur_technique: 'Erreur technique'
  };
  var STATUTS_PANIER = { en_cours: 'En cours (non validé)', valide: 'Validé', abandonne: 'Abandonné' };
  var MODES_PANIER = { livraison: 'Livraison', a_emporter: 'À emporter', sur_place: 'Sur place' };

  async function chargerPanier(appelId) {
    try {
      var r = await supabaseClient.from('panier_commandes').select('*').eq('appel_id', appelId).limit(1);
      if (r.error || !r.data || !r.data.length) return null;
      var p = r.data[0];
      var res = await Promise.all([
        supabaseClient.from('panier_lignes').select('*').eq('panier_id', p.id).order('numero', { ascending: true }),
        supabaseClient.from('panier_journal').select('*').eq('panier_id', p.id).order('created_at', { ascending: true })
      ]);
      return { panier: p, lignes: res[0].data || [], journal: res[1].data || [] };
    } catch (e) {
      console.warn('[agent-vocal] panier indisponible :', e && e.message);
      return null;
    }
  }
  function libelleLigne(l) {
    var t = (Number(l.quantite) > 1 ? l.quantite + ' × ' : '') + l.nom_produit;
    var ch = Array.isArray(l.choix) ? l.choix : [], re = Array.isArray(l.retraits) ? l.retraits : [];
    if (ch.length) t += ' — ' + ch.join(', ');
    if (re.length) t += ' — sans ' + re.join(', sans ');
    if (l.instructions) t += ' (' + l.instructions + ')';
    return t;
  }
  function blocPanier(d) {
    var p = d.panier;
    var couleur = p.statut === 'valide' ? '#2e7d32' : (p.statut === 'abandonne' ? '#c62828' : '#b26a00');
    var adr = [p.adresse, [p.code_postal, p.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    var infos = ligne('Mode', MODES_PANIER[p.type_livraison] || '—');
    if (p.type_livraison === 'livraison') infos += ligne('Adresse', adr || '—') + ligne('Zone', p.zone_livraison || '—') + (p.instructions_acces ? ligne('Accès', p.instructions_acces) : '');
    infos += ligne('Client', [p.prenom_client, p.telephone_commande || p.telephone].filter(Boolean).join(' · ') || '—');
    if (p.heure_souhaitee) infos += ligne('Heure souhaitée', (p.date_souhaitee ? String(p.date_souhaitee).slice(0, 10) + ' ' : '') + p.heure_souhaitee);
    var articles = d.lignes.length
      ? d.lignes.map(function (l) { return ligne(l.numero + '. ' + libelleLigne(l), fe(l.prix_ligne)); }).join('')
      : '<div style="font-size:13px;color:#666;">Panier vide</div>';
    if (p.prix_final != null) articles += ligne('Total annoncé (frais inclus)', fe(p.prix_final), true);
    var chrono = d.journal.map(function (x) {
      var h = x.created_at ? new Date(x.created_at).toLocaleTimeString('fr-FR') : '';
      var msg = String(x.message || '');
      if (msg.length > 150) msg = msg.slice(0, 150) + '…';
      return '<div style="padding:4px 0;border-bottom:1px solid #eee;font-size:13px;"><div style="display:flex;justify-content:space-between;gap:10px;"><span><span style="color:#999;">' + esc(h) + '</span> · <b>' + esc(ACTIONS_PANIER[x.action] || String(x.action || '').replace(/_/g, ' ')) + '</b></span><span style="color:' + (x.succes === false ? '#c62828' : '#2e7d32') + ';">' + (x.succes === false ? '✗' : '✓') + '</span></div>' + (msg ? '<div style="color:#666;font-size:12px;">' + esc(msg) + '</div>' : '') + '</div>';
    }).join('');
    return '<div class="av-detail-panier" style="background:#f8f9fa;padding:16px;border-radius:8px;margin-bottom:16px;border-left:4px solid ' + couleur + ';">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;"><strong>🛒 Panier de l\'appel</strong><span style="padding:2px 8px;border-radius:6px;background:#fff;border:1px solid ' + couleur + ';color:' + couleur + ';font-size:12px;font-weight:700;">' + esc(STATUTS_PANIER[p.statut] || p.statut) + '</span></div>' +
      bloc('Commande', infos) + bloc('Articles', articles) +
      (chrono ? '<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:13px;color:#1f5f8b;">Chronologie du panier (' + d.journal.length + ' actions)</summary>' + chrono + '</details>' : '') +
      '</div>';
  }

  var rendreOrigine = window.renderEvenements;
  window.renderEvenements = function () {
    var r = rendreOrigine.apply(this, arguments);
    setTimeout(decorer, 0);
    return r;
  };

  var detailOrigine = window.openEvenementDetail;
  window.openEvenementDetail = function (id) {
    var r = detailOrigine.apply(this, arguments);
    (async function () {
      try {
        var evt = liste().find(function (e) { return String(e.id) === String(id); });
        if (!estLiveKit(evt)) return;
        var modal = document.getElementById('modal-commande');
        if (!modal) return;
        modal.setAttribute('data-av-evt', String(id));
        await charger([evt.call_id]);
        var l = cache[evt.call_id];
        var corps = modal.querySelector('.modal-body');
        if (!corps || modal.getAttribute('data-av-evt') !== String(id)) return;
        var cartes = Array.prototype.slice.call(corps.children);
        var infos = cartes.filter(function (x) { return x.textContent.indexOf('Informations appel') >= 0; })[0];
        if (l && !modal.querySelector('.av-detail-technique')) {
          var html = blocDetail(l);
          if (infos) infos.insertAdjacentHTML('afterend', html); else corps.insertAdjacentHTML('beforeend', html);
        }
        var dp = await chargerPanier(evt.call_id);
        if (dp && modal.getAttribute('data-av-evt') === String(id) && !modal.querySelector('.av-detail-panier')) {
          var tech = modal.querySelector('.av-detail-technique');
          if (tech) tech.insertAdjacentHTML('beforebegin', blocPanier(dp));
          else if (infos) infos.insertAdjacentHTML('afterend', blocPanier(dp));
          else corps.insertAdjacentHTML('beforeend', blocPanier(dp));
        }
      } catch (e) {
        console.warn('[agent-vocal] Journal : détail technique indisponible', e);
      }
    })();
    return r;
  };

  // Si le Journal est déjà affiché, on ajoute tout de suite les informations
  setTimeout(decorer, 0);
})();

/* =====================================================================
   Module « Commandes et indépendance d'ElevenLabs » (Agent V2)
   SANS modifier l'existant : les fonctions openCommandeDetail,
   chargerAppelsSansCommande et afficherResultatKb sont remplacées ou
   enveloppées ici ; rien n'est supprimé dans index.html.
     - Commandes : bloc « Détail des prix » (prix de base, choix payants,
       suppléments, frais de livraison, contrôle du total) ;
     - Commandes : le bandeau « commande non créée » signale aussi les
       paniers laissés sans validation ;
     - ElevenLabs : boutons de publication retirés (le menu n'est plus
       envoyé vers ElevenLabs), textes d'aide mis à jour.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__saiosV2Commandes) return;
  if (typeof window.openCommandeDetail !== 'function' || typeof supabaseClient === 'undefined') {
    console.warn('[agent-vocal] module Commandes non chargé (page inattendue)');
    return;
  }
  window.__saiosV2Commandes = true;

  var esc = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var eur = function (x) { return Number(x).toFixed(2).replace('.', ',') + ' €'; };
  var liste = function (x) { return (Array.isArray(x) ? x : (x ? String(x).split(',') : [])).map(function (v) { return String(v).trim(); }).filter(Boolean); };
  var cmdListe = function () { try { return (typeof commandes !== 'undefined' && Array.isArray(commandes)) ? commandes : []; } catch (e) { return []; } };
  var CLE_MODE = { livraison: 'livraison', a_emporter: 'emporter', sur_place: 'sur_place' };
  var CHAMP_PRIX = { livraison: 'prix_livraison', emporter: 'prix_emporter', sur_place: 'prix_sur_place' };
  var LIB_MODE = { livraison: 'livraison', a_emporter: 'à emporter', sur_place: 'sur place' };

  /* ---------- Détail des prix d'une commande ---------- */
  async function calculerDetailPrix(cmd) {
    var items = cmd.produits_commandes || [];
    if (!items.length) return null;
    var ids = Array.from(new Set(items.map(function (i) { return i.produit_id; }).filter(Boolean)));
    var rp = await supabaseClient.from('produits')
      .select('id, nom, famille_id, taille, prix, prix_livraison, prix_emporter, prix_sur_place').in('id', ids);
    if (rp.error) throw rp.error;
    var prods = {};
    (rp.data || []).forEach(function (p) { prods[p.id] = p; });
    var cle = CLE_MODE[cmd.type_livraison] || 'sur_place';
    var champ = CHAMP_PRIX[cle];
    var lignes = [], somme = 0;
    for (var k = 0; k < items.length; k++) {
      var it = items[k], p = prods[it.produit_id] || {};
      var q = Number(it.quantite) || 1;
      var base = (p[champ] !== null && p[champ] !== undefined) ? Number(p[champ])
        : Number(p.prix != null ? p.prix : (it.produit && it.produit.prix) || 0);
      var choix = liste((it.attributs_choisis || {}).supplements);
      var details = [];
      if (choix.length) {
        var r = await supabaseClient.rpc('panier_prix_par_choix', {
          p_business_id: cmd.business_id || BUSINESS_ID, p_produit_id: it.produit_id,
          p_famille_id: p.famille_id || null, p_taille: p.taille || null, p_cle_prix: cle, p_choix: choix
        });
        if (!r.error && Array.isArray(r.data)) details = r.data;
      }
      var payants = details.filter(function (d) { return Number(d.prix_choix) > 0; });
      var inclus = details.length
        ? details.filter(function (d) { return !(Number(d.prix_choix) > 0); }).map(function (d) { return d.nom_choix; })
        : choix;
      var calcule = base * q + payants.reduce(function (s, d) { return s + Number(d.prix_choix); }, 0);
      var enregistre = Number(it.total);
      somme += Number.isFinite(enregistre) ? enregistre : 0;
      lignes.push({ qte: q, nom: (p.nom || (it.produit && it.produit.nom) || 'Produit'), base: base, payants: payants, inclus: inclus,
        calcule: calcule, enregistre: enregistre, ecart: Number.isFinite(enregistre) ? enregistre - calcule : 0 });
    }
    var total = Number(cmd.prix);
    var frais = Number.isFinite(total) ? Math.round((total - somme) * 100) / 100 : 0;
    return { lignes: lignes, frais: frais > 0.009 ? frais : 0, total: total, cle: cle };
  }

  function rangee(a, b, fort, couleur) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:1px 0;' + (fort ? 'font-weight:700;' : '') + (couleur ? 'color:' + couleur + ';' : '') + '"><span>' + a + '</span><span style="white-space:nowrap;">' + b + '</span></div>';
  }

  function htmlDetailPrix(d, cmd) {
    var h = '<div class="av-detail-prix" style="margin-bottom:16px;"><strong>💶 Détail des prix</strong>' +
      '<div style="font-size:12px;color:#888;margin:2px 0 8px;">Prix ' + esc(LIB_MODE[cmd.type_livraison] || '') + '. Un choix est payant s\'il est hors du quota inclus ou proposé en supplément.</div>';
    d.lignes.forEach(function (l) {
      h += '<div style="background:#f8f9fa;padding:10px 12px;border-radius:8px;margin-bottom:6px;font-size:14px;">';
      h += rangee('<strong>' + l.qte + ' ×</strong> ' + esc(l.nom), eur(l.enregistre), true);
      h += rangee('<span style="color:#666;">Prix de base' + (l.qte > 1 ? ' (' + l.qte + ' × ' + eur(l.base) + ')' : '') + '</span>', eur(l.base * l.qte));
      l.payants.forEach(function (c) {
        h += rangee('<span style="color:#666;">+ ' + esc(String(c.nom_choix).toLowerCase()) + ' <span style="font-size:11px;">(' + (c.origine_choix === 'supplement' ? 'supplément' : 'choix payant') + ')</span></span>', '+ ' + eur(c.prix_choix));
      });
      if (l.inclus.length) h += '<div style="font-size:12px;color:#888;margin-top:3px;">Inclus : ' + esc(l.inclus.map(function (x) { return String(x).toLowerCase(); }).join(', ')) + '</div>';
      if (Math.abs(l.ecart) > 0.009) {
        h += '<div style="font-size:12px;color:#c0392b;margin-top:3px;">⚠️ Écart : calculé ' + eur(l.calcule) + ', enregistré ' + eur(l.enregistre) + ' (à vérifier)</div>';
      }
      h += '</div>';
    });
    if (d.frais > 0) h += rangee('Frais de livraison', eur(d.frais));
    h += '</div>';
    return h;
  }

  var detailOrigine = window.openCommandeDetail;
  window.openCommandeDetail = function (id) {
    var r = detailOrigine.apply(this, arguments);
    (async function () {
      try {
        var cmd = cmdListe().find(function (c) { return String(c.id) === String(id); });
        if (!cmd) return;
        var modal = document.getElementById('modal-commande');
        if (!modal) return;
        modal.setAttribute('data-saios-cmd', String(id));
        var d = await calculerDetailPrix(cmd);
        if (!d || modal.getAttribute('data-saios-cmd') !== String(id) || modal.querySelector('.av-detail-prix')) return;
        var corps = modal.querySelector('.modal-body');
        if (!corps) return;
        var blocs = Array.prototype.slice.call(corps.children);
        var articles = blocs.filter(function (x) { return x.textContent.trim().indexOf('📦 Articles') === 0; })[0];
        var html = htmlDetailPrix(d, cmd);
        if (articles) articles.insertAdjacentHTML('afterend', html); else corps.insertAdjacentHTML('beforeend', html);
      } catch (e) {
        console.warn('[agent-vocal] détail des prix indisponible', e && e.message);
      }
    })();
    return r;
  };

  /* ---------- Bandeau « commande annoncée mais non créée » : inclut les paniers non validés ---------- */
  window.chargerAppelsSansCommande = async function () {
    var zone = document.getElementById('commandes-alerte');
    if (!zone) return;
    try {
      var depuis = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      var r = await supabaseClient.from('evenements').select('*')
        .eq('business_id', BUSINESS_ID).eq('type_evenement', 'appel_termine').eq('statut', 'a_verifier')
        .is('traite_le', null)
        .gte('created_at', depuis).order('created_at', { ascending: false }).limit(50);
      if (r.error) throw r.error;
      var lire = function (e) { var d = e.details || {}; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = {}; } } return d; };
      var manquantes = (r.data || []).filter(function (e) {
        var d = lire(e);
        var anom = Array.isArray(d.anomalies) ? d.anomalies : [];
        var annonce = d.montant_annonce || (Array.isArray(d.articles) && d.articles.length > 0) || (Array.isArray(d.panier) && d.panier.length > 0);
        return d.commande_creee === false && annonce && !anom.some(function (a) { return a.type === 'refus_client'; });
      });
      if (manquantes.length === 0) { zone.innerHTML = ''; return; }
      manquantes.forEach(function (e) { if (!evenements.some(function (x) { return x.id === e.id; })) evenements.push(e); });
      var lignes = manquantes.map(function (e) {
        var d = lire(e);
        var anom = Array.isArray(d.anomalies) ? d.anomalies : [];
        var raison = (anom.find(function (a) { return ['panier_non_valide', 'refus_metier', 'erreur_technique', 'aucun_produit_reconnu', 'articles_non_extraits'].indexOf(a.type) >= 0; }) || anom[0] || {}).message || '';
        var quand = new Date(e.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
        return '<div id="alerte-' + esc(e.id) + '" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;">' +
          '<span><strong>' + esc(quand) + '</strong> · ' + esc(e.client_nom || 'client inconnu') + ' ' + esc(e.client_telephone || '') + '</span>' +
          '<span style="color:var(--muted);flex:1;min-width:200px;">' + esc(raison) + '</span>' +
          '<button class="btn btn-sm btn-secondary" onclick="openEvenementDetail(\'' + esc(e.id) + '\')">Voir l\'appel</button>' +
          '<button class="btn-close" style="position:static;font-size:20px;line-height:1;" title="Marquer comme traité (retire l\'alerte)" onclick="marquerAppelTraite(\'' + esc(e.id) + '\')">×</button></div>';
      }).join('');
      zone.innerHTML = '<div class="groupe-note" id="commandes-alerte-bloc" style="margin-bottom:14px;">' +
        '<strong>⚠️ <span id="commandes-alerte-titre">' + manquantes.length + ' appel(s)</span> des 7 derniers jours : commande annoncée ou panier rempli, mais NON créée.</strong> À saisir à la main ou à rappeler.' +
        '<div id="commandes-alerte-lignes">' + lignes + '</div></div>';
    } catch (err) {
      console.warn('Appels sans commande : vérification impossible', err);
      zone.innerHTML = '';
    }
  };

  /* ---------- Indépendance d'ElevenLabs : fin de la publication du menu et des zones ---------- */
  var texteAgent = '🤖 Cette section définit le comportement de l\'agent vocal : les <strong>règles</strong> qu\'il applique (questions à poser, déductions de taille, exclusivités, prononciation). ' +
    'Les boutons « Aperçu », en haut, montrent le texte du <strong>menu</strong> et des <strong>zones de livraison</strong> construit d\'après les données du restaurant. ' +
    'Plus rien n\'est publié vers ElevenLabs : l\'agent LiveKit utilise le prompt choisi dans <strong>Agent vocal › Prompts de l\'agent</strong>.';

  window.afficherResultatKb = function (kb, filename) {
    window.__kbFilename = filename;
    var estZones = String(filename).indexOf('ZONE') >= 0;
    window.__kbType = estZones ? 'zones' : 'menu';
    var titre = estZones ? '📍 Texte des zones de livraison' : '📄 Texte du menu';
    var modal = document.getElementById('modal-edit');
    modal.innerHTML = '<div class="modal-content" onclick="event.stopPropagation()" style="max-width:760px;">' +
      '<div class="modal-header"><h2>' + titre + '</h2><button class="btn-close" onclick="closeModal(\'modal-edit\')">×</button></div>' +
      '<div class="modal-body">' +
      '<div style="background:#e7f1f8;border:1px solid #cfe1ee;border-left:4px solid #2c6e9c;border-radius:8px;padding:11px 14px;font-size:13px;margin-bottom:12px;color:#2c5a7a;">' +
      '💡 Aperçu généré à partir des données du restaurant (produits, choix, prix, zones, horaires). Il n\'est plus envoyé vers ElevenLabs. Copie ou télécharge-le si besoin.</div>' +
      '<textarea id="kb-output" style="width:100%;min-height:340px;font-family:monospace;font-size:12px;border:1px solid var(--line);border-radius:8px;padding:12px;">' + String(kb).replace(/</g, '&lt;') + '</textarea>' +
      '<div class="form-actions"><button class="btn btn-secondary" onclick="copierKb()">📋 Copier</button><button class="btn btn-secondary" onclick="telechargerKb()">⬇️ Télécharger</button></div>' +
      '</div></div>';
  };

  // Garde-fous : si un ancien appel survivait quelque part, il n'envoie plus rien vers ElevenLabs
  var abandonne = function () { alert('La publication vers ElevenLabs est supprimée : l\'agent LiveKit n\'en a plus besoin.'); };
  window.publierKbVersElevenLabs = abandonne;
  window.publierRestaurantActuel = abandonne;
  window.publierToutLesRestaurants = abandonne;

  function nettoyerInterface() {
    ['btn-publier-tout-flottant', 'btn-publier-restaurant'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    var resume = document.querySelector('#agent-actions summary');
    if (resume) resume.textContent = '📄 Aperçu des textes de l\'agent ▾';
    var m = document.getElementById('btn-gen-kbmenu'); if (m) m.textContent = '📄 Aperçu du menu';
    var z = document.getElementById('btn-gen-kbzones'); if (z) z.textContent = '📍 Aperçu des zones de livraison';
    var aide = document.querySelector('#param-agent .options-help');
    if (aide) aide.innerHTML = texteAgent;
  }
  nettoyerInterface();
})();
