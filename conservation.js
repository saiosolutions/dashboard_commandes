/* ============================================================
   conservation.js  (v1)
   Extension du back-office (même principe que notifications-fournisseur.js) :
   - encart « Durée de conservation » en haut à droite de Paramétrages > Fiche du restaurant
   - trois durées en jours, de 0 à 1000, propres à chaque restaurant :
       1. après un envoi réussi (ou une commande réussie pour un restaurant non API)
       2. après un échec d'envoi (ou une commande « À vérifier » pour un restaurant non API)
       3. données anonymisées (mesures techniques des appels)
   - enregistrement dans business.type_params.conservation (réussite, échec, anonymisé)
   Ne modifie aucune fonction existante : elle ajoute seulement un affichage après elles.
   La purge elle-même est faite côté Supabase par la fonction purge_donnees_personnelles.
   ============================================================ */
(function () {
  'use strict';
  if (window.__conservationChargee) return;
  window.__conservationChargee = true;

  var MAX_JOURS = 1000;
  var DEFAUTS = { reussite_jours: 3, echec_jours: 3, anonymise_jours: 60 };

  // ---------- Apparence : mêmes couleurs que le reste du back-office ----------
  var style = document.createElement('style');
  style.textContent = [
    '.conserv-encart { float: right; clear: right; width: 320px; box-sizing: border-box; margin: 0 0 16px 16px; background: white; border-radius: 12px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }',
    '.conserv-encart h3 { margin: 0 0 4px; font-size: 16px; }',
    '.conserv-encart .conserv-type { display: inline-block; margin-bottom: 8px; }',
    '.conserv-encart .conserv-aide { font-size: 12px; color: var(--muted); margin-bottom: 12px; line-height: 1.45; }',
    '.conserv-encart .conserv-ligne { display: grid; grid-template-columns: minmax(0, 1fr) 84px 38px; gap: 8px; align-items: center; margin-bottom: 10px; }',
    '.conserv-encart .conserv-ligne label { font-size: 13px; line-height: 1.35; }',
    '.conserv-encart .conserv-ligne input { width: 100%; box-sizing: border-box; min-height: 40px; padding: 0 8px; text-align: right; font-weight: 600; border: 1px solid #8a929c; border-radius: 8px; }',
    '.conserv-encart .conserv-ligne input:focus-visible { outline: 3px solid rgba(95,104,115,0.45); outline-offset: 1px; }',
    '.conserv-encart .conserv-ligne span { font-size: 12px; color: var(--muted); }',
    '.conserv-encart .conserv-pied { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }',
    '.conserv-encart .conserv-msg { font-size: 12.5px; min-height: 18px; }',
    '.conserv-encart .conserv-msg.ok { color: var(--ok); }',
    '.conserv-encart .conserv-msg.err { color: var(--err); }',
    '@media (max-width: 1100px) { .conserv-encart { float: none; clear: none; width: auto; max-width: 760px; margin: 0 0 16px 0; } }'
  ].join('\n');
  document.head.appendChild(style);

  // ---------- Petits outils ----------
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function entierValide(texte) {
    var s = String(texte == null ? '' : texte).trim();
    if (!/^\d+$/.test(s)) return null;
    var n = parseInt(s, 10);
    return n >= 0 && n <= MAX_JOURS ? n : null;
  }

  function nombreOuDefaut(valeur, defaut) {
    var n = Number(valeur);
    return (valeur !== null && valeur !== undefined && valeur !== '' && isFinite(n) && n >= 0 && n <= MAX_JOURS) ? Math.round(n) : defaut;
  }

  function afficherMessage(texte, genre) {
    var m = document.getElementById('conserv-msg');
    if (!m) return;
    m.className = 'conserv-msg' + (genre ? ' ' + genre : '');
    m.textContent = texte || '';
  }

  // ---------- Lecture des réglages (restaurant, sinon défaut global) ----------
  async function lireReglages(bid) {
    var defauts = { reussite_jours: DEFAUTS.reussite_jours, echec_jours: DEFAUTS.echec_jours, anonymise_jours: DEFAUTS.anonymise_jours };
    try {
      var g = await supabaseClient.from('reglages_globaux').select('valeur').eq('cle', 'conservation_defaut').limit(1);
      if (!g.error && g.data && g.data.length && g.data[0].valeur) {
        var v = g.data[0].valeur;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = {}; } }
        defauts.reussite_jours = nombreOuDefaut(v.reussite_jours, defauts.reussite_jours);
        defauts.echec_jours = nombreOuDefaut(v.echec_jours, defauts.echec_jours);
        defauts.anonymise_jours = nombreOuDefaut(v.anonymise_jours, defauts.anonymise_jours);
      }
    } catch (e) { console.warn('conservation : défauts globaux illisibles', e); }

    var r = await supabaseClient.from('business').select('id_externe, type_params').eq('id', bid).single();
    if (r.error) throw r.error;
    var tp = r.data.type_params || {};
    if (typeof tp === 'string') { try { tp = JSON.parse(tp); } catch (e) { tp = {}; } }
    var c = tp.conservation || {};
    return {
      api: !!(r.data.id_externe && String(r.data.id_externe).trim() !== ''),
      reussite_jours: nombreOuDefaut(c.reussite_jours, defauts.reussite_jours),
      echec_jours: nombreOuDefaut(c.echec_jours, defauts.echec_jours),
      anonymise_jours: nombreOuDefaut(c.anonymise_jours, defauts.anonymise_jours)
    };
  }

  // ---------- Affichage de l'encart ----------
  function ligne(id, libelle, valeur) {
    return '<div class="conserv-ligne">' +
      '<label for="' + id + '">' + esc(libelle) + '</label>' +
      '<input type="number" inputmode="numeric" min="0" max="' + MAX_JOURS + '" step="1" id="' + id + '" value="' + esc(valeur) + '">' +
      '<span>jours</span></div>';
  }

  async function injecter() {
    var zone = document.getElementById('fiche-contenu');
    if (!zone) return;
    if (zone.querySelector('.loading') || zone.querySelector('.no-data')) return;   // la fiche n'a pas pu se charger
    if (zone.querySelector('#conserv-encart')) return;
    var bid = BUSINESS_ID;
    var reglages;
    try { reglages = await lireReglages(bid); }
    catch (e) { console.warn('conservation : lecture impossible', e); return; }
    if (bid !== BUSINESS_ID) return;                    // le restaurant a changé pendant la lecture
    if (zone.querySelector('#conserv-encart')) return;
    var l1 = reglages.api ? 'Après envoi réussi' : 'Après commande réussie';
    var l2 = reglages.api ? 'Après échec d\'envoi' : 'Après commande « À vérifier »';
    var d = document.createElement('div');
    d.className = 'conserv-encart';
    d.id = 'conserv-encart';
    d.innerHTML =
      '<h3>Durée de conservation</h3>' +
      '<span class="badge badge-info conserv-type">' + (reglages.api ? 'Restaurant API' : 'Restaurant non API') + '</span>' +
      '<div class="conserv-aide">Nombre de jours avant l\'effacement du nom, du téléphone et de l\'adresse. De 0 à ' + MAX_JOURS + ' jours. Propre à ce restaurant.</div>' +
      ligne('conserv-reussite', l1, reglages.reussite_jours) +
      ligne('conserv-echec', l2, reglages.echec_jours) +
      ligne('conserv-anonymise', 'Données anonymisées (mesures techniques)', reglages.anonymise_jours) +
      '<div class="conserv-pied"><div class="conserv-msg" id="conserv-msg" role="status" aria-live="polite"></div>' +
      '<button type="button" class="btn btn-primary" id="conserv-bouton" onclick="enregistrerConservation()">Enregistrer</button></div>';
    zone.insertBefore(d, zone.firstChild);
  }

  // ---------- Enregistrement ----------
  window.enregistrerConservation = async function () {
    var a = entierValide((document.getElementById('conserv-reussite') || {}).value);
    var b = entierValide((document.getElementById('conserv-echec') || {}).value);
    var c = entierValide((document.getElementById('conserv-anonymise') || {}).value);
    if (a === null || b === null || c === null) {
      afficherMessage('Entiers de 0 à ' + MAX_JOURS + ' uniquement.', 'err');
      return;
    }
    var bouton = document.getElementById('conserv-bouton');
    if (bouton) bouton.disabled = true;
    afficherMessage('Enregistrement…', '');
    try {
      var bid = BUSINESS_ID;
      var cur = await supabaseClient.from('business').select('type_params').eq('id', bid).single();
      if (cur.error) throw cur.error;
      var tp = cur.data.type_params || {};
      if (typeof tp === 'string') { try { tp = JSON.parse(tp); } catch (e) { tp = {}; } }
      var maj = Object.assign({}, tp, { conservation: { reussite_jours: a, echec_jours: b, anonymise_jours: c } });
      var up = await supabaseClient.from('business').update({ type_params: maj }).eq('id', bid);
      if (up.error) throw up.error;
      afficherMessage('Enregistré.', 'ok');
    } catch (e) {
      console.warn('conservation : enregistrement impossible', e);
      afficherMessage('Échec de l\'enregistrement : ' + (e && e.message ? e.message : 'erreur inconnue'), 'err');
    } finally {
      if (bouton) bouton.disabled = false;
    }
  };


  // ---------- Branchement sur le back-office existant (sans le modifier) ----------
  function apres(nom, action) {
    var original = window[nom];
    if (typeof original !== 'function') { console.warn('conservation : fonction introuvable', nom); return; }
    window[nom] = async function () {
      var resultat = await original.apply(this, arguments);
      try { action.apply(this, arguments); } catch (e) { console.warn('conservation', nom, e); }
      return resultat;
    };
  }

  apres('chargerFiche', function () { injecter(); });
})();
