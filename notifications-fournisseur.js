/* ============================================================
   notifications-fournisseur.js
   Extension du back-office (même principe que agent-vocal.js) :
   - bloc repliable « Notifications du fournisseur » dans Paramétrages > Connexion API
   - pastille rouge sur « Connexion API » et sur l'onglet « Paramétrages » si la dernière synchro automatique est en erreur
   Ne modifie aucune fonction existante : elle ajoute seulement un affichage après elles.
   Lecture seule de la table webhook_evenements (règle SQL « select » pour l'admin connecté).
   ============================================================ */
(function () {
  'use strict';
  if (window.__notifFournisseurChargee) return;
  window.__notifFournisseurChargee = true;

  var DELAI_BLOQUE_MIN = 10;      // une notification restée « reçue » plus longtemps est jugée bloquée
  var INTERVALLE_MS = 60000;      // rafraîchissement automatique de la pastille
  var NB_LIGNES = 20;
  var notifOuvert = false;        // mémorise si le bloc est déplié, entre deux rechargements de la page
  var minuteur = null;
  var enCours = false;

  // ---------- Apparence : mêmes couleurs que le reste du back-office ----------
  var style = document.createElement('style');
  style.textContent = [
    '.notif-fournisseur { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); max-width: 760px; margin-top: 18px; }',
    '.notif-fournisseur > summary { list-style: none; cursor: pointer; padding: 14px 18px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-weight: 700; font-size: 15px; border-radius: 12px; }',
    '.notif-fournisseur > summary::-webkit-details-marker { display: none; }',
    '.notif-fournisseur > summary::before { content: "\\25B8"; display: inline-block; color: var(--muted); transition: transform 0.15s; }',
    '.notif-fournisseur[open] > summary::before { transform: rotate(90deg); }',
    '.notif-fournisseur > summary:focus-visible { outline: 3px solid rgba(95,104,115,0.45); outline-offset: 2px; }',
    '.notif-fournisseur .notif-etat { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; font-size: 13px; color: var(--muted); }',
    '.notif-fournisseur .notif-corps { padding: 0 18px 18px; }',
    '.notif-fournisseur .notif-entete { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }',
    '.notif-fournisseur .notif-aide { font-size: 12px; color: var(--muted); flex: 1; min-width: 200px; }',
    '.notif-fournisseur .notif-alerte { background: var(--err-bg); color: var(--err); border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 12px; }',
    '.notif-fournisseur td, .notif-fournisseur th { white-space: nowrap; }',
    '.notif-fournisseur td.notif-detail { white-space: normal; min-width: 220px; font-size: 13px; }',
    '.nav-pastille.err, .nav-pastille.ok.err, .nav-pastille.warn.err { background: var(--err); }',
    '.tab .notif-point { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--err); margin-left: 7px; vertical-align: middle; }',
    '@media (prefers-reduced-motion: reduce) { .notif-fournisseur > summary::before { transition: none; } }'
  ].join('\n');
  document.head.appendChild(style);

  // ---------- Petits outils ----------
  function esc(t) {
    return (typeof escHtml === 'function') ? escHtml(t) :
      String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function libelleType(t) {
    var m = {
      mise_a_jour_carte: 'Carte (produits)',
      mise_a_jour_restaurant: 'Infos du restaurant',
      mise_a_jour_livraison: 'Livraison',
      mise_a_jour_parametres: 'Modes de commande'
    };
    return m[t] || t || '?';
  }

  function ilYa(iso) {
    if (!iso) return '';
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "à l'instant";
    var min = Math.floor(s / 60);
    if (min < 60) return 'il y a ' + min + ' min';
    var h = Math.floor(min / 60);
    if (h < 24) return 'il y a ' + h + ' h';
    var j = Math.floor(h / 24);
    return 'il y a ' + j + ' jour' + (j > 1 ? 's' : '');
  }

  function estBloquee(ev) {
    return ev.etat === 'recu' && ev.recu_le &&
      (Date.now() - new Date(ev.recu_le).getTime()) > DELAI_BLOQUE_MIN * 60000;
  }

  // Résumé lisible de ce que la synchro a changé
  function resumeResultat(r) {
    if (!r || typeof r !== 'object' || !r.ecriture || typeof r.ecriture !== 'object') return '';
    var e = r.ecriture;
    var n = function (o, c) { return (o && o[c] != null) ? Number(o[c]) || 0 : 0; };
    var morceaux = [];
    if (n(e.produits, 'crees') + n(e.produits, 'modifies') > 0) {
      morceaux.push('produits : ' + n(e.produits, 'crees') + ' créé(s), ' + n(e.produits, 'modifies') + ' modifié(s)');
    }
    if (n(e.zones, 'creees') + n(e.zones, 'modifiees') > 0) {
      morceaux.push('zones : ' + n(e.zones, 'creees') + ' créée(s), ' + n(e.zones, 'modifiees') + ' modifiée(s)');
    }
    var absents = n(e.groupes_options, 'marques_absents');
    if (absents > 0) morceaux.push(absents + " groupe(s) d'options retiré(s) chez le fournisseur");
    return morceaux.length ? morceaux.join(' · ') : 'produits et zones inchangés';
  }

  // État d'une notification : pastille de texte + niveau
  function badgeEtat(ev) {
    if (ev.etat === 'erreur') return '<span class="badge badge-danger">Erreur</span>';
    if (estBloquee(ev)) return '<span class="badge badge-danger">Bloquée</span>';
    if (ev.etat === 'traite') return '<span class="badge badge-success">Traitée</span>';
    if (ev.etat === 'ignore') return '<span class="badge badge-warning">Ignorée</span>';
    return '<span class="badge badge-info">En cours</span>';
  }

  // Évalue la situation du restaurant affiché : on regarde la dernière notification qui le concerne.
  // Chaque notification relance une synchro complète : un succès plus récent efface donc une erreur plus ancienne.
  function evaluer(events, bid) {
    var siennes = events.filter(function (e) { return e.business_id === bid && e.etat !== 'ignore'; });
    if (siennes.length === 0) return { niveau: 'aucune', dernier: null };
    var d = siennes[0];
    if (d.etat === 'erreur') return { niveau: 'erreur', dernier: d };
    if (estBloquee(d)) return { niveau: 'bloquee', dernier: d };
    return { niveau: 'ok', dernier: d };
  }

  // ---------- Lecture des notifications ----------
  async function charger() {
    try {
      var bid = BUSINESS_ID;
      var res = await supabaseClient.from('webhook_evenements').select('*')
        .or('business_id.eq.' + bid + ',business_id.is.null')
        .order('recu_le', { ascending: false }).limit(NB_LIGNES);
      if (res.error) throw res.error;
      return res.data || [];
    } catch (err) {
      console.warn('Notifications du fournisseur : lecture impossible', err);
      return { erreur: err && err.message ? err.message : String(err) };
    }
  }

  // ---------- Pastilles rouges ----------
  function appliquerPastilles(situation) {
    var alerte = situation && (situation.niveau === 'erreur' || situation.niveau === 'bloquee');
    var p = document.getElementById('pastille-api');
    var c = document.getElementById('compte-api');
    if (p) p.classList.toggle('err', !!alerte);
    if (c) {
      if (alerte) c.textContent = 'en erreur';
      else if (c.textContent === 'en erreur') {
        c.textContent = (typeof businessCourantRelie === 'function' && businessCourantRelie()) ? 'reliée' : 'non reliée';
      }
    }
    var onglets = document.querySelectorAll('.tabs .tab');
    for (var i = 0; i < onglets.length; i++) {
      if (/Paramétrages/.test(onglets[i].textContent)) {
        var point = onglets[i].querySelector('.notif-point');
        if (alerte && !point) {
          point = document.createElement('span');
          point.className = 'notif-point';
          point.title = 'La dernière synchro automatique du fournisseur est en erreur';
          onglets[i].appendChild(point);
        } else if (!alerte && point) {
          point.remove();
        }
      }
    }
  }

  // ---------- Bloc repliable dans Connexion API ----------
  function afficherBloc(events, situation) {
    var etat = document.getElementById('notif-etat');
    var corps = document.getElementById('notif-corps');
    if (!etat || !corps) return;

    if (!Array.isArray(events)) {
      etat.innerHTML = '<span class="badge badge-warning">Lecture impossible</span>';
      corps.innerHTML = '<div class="notif-alerte">Impossible de lire les notifications : ' + esc(events.erreur) +
        '<br>Si le message parle d\'une autorisation, la règle de lecture SQL n\'a pas encore été ajoutée.</div>';
      return;
    }

    // Ligne toujours visible
    var d = situation.dernier;
    if (situation.niveau === 'aucune') {
      etat.innerHTML = '<span class="badge badge-info">Aucune notification reçue</span>';
    } else if (situation.niveau === 'erreur') {
      etat.innerHTML = '<span class="badge badge-danger">Dernière synchro en erreur</span><span>' + esc(ilYa(d.recu_le)) + '</span>';
    } else if (situation.niveau === 'bloquee') {
      etat.innerHTML = '<span class="badge badge-danger">Synchro bloquée</span><span>' + esc(ilYa(d.recu_le)) + '</span>';
    } else {
      etat.innerHTML = '<span class="badge badge-success">Tout est à jour</span><span>dernière notification ' + esc(ilYa(d.recu_le)) + '</span>';
    }

    // Contenu déplié
    var html = '';
    if (situation.niveau === 'erreur') {
      html += '<div class="notif-alerte"><strong>La dernière synchro automatique a échoué</strong>' +
        (d.message_erreur ? ' : ' + esc(d.message_erreur) : '') +
        '.<br>La carte de ce restaurant n\'est peut-être pas à jour. Le bouton « Synchroniser depuis l\'API », plus haut, la remet à jour.</div>';
    } else if (situation.niveau === 'bloquee') {
      html += '<div class="notif-alerte"><strong>Une notification est restée « en cours » depuis plus de ' + DELAI_BLOQUE_MIN + ' minutes</strong> : ' +
        'la synchro ne s\'est probablement pas terminée. Le bouton « Synchroniser depuis l\'API », plus haut, la remet à jour.</div>';
    }
    html += '<div class="notif-entete"><span class="notif-aide">Les ' + NB_LIGNES + ' dernières. Chaque notification relance une synchro complète du restaurant.</span>' +
      '<button type="button" class="btn btn-secondary btn-sm" onclick="window.__notifActualiser()">🔄 Actualiser</button></div>';

    if (events.length === 0) {
      html += '<div class="no-data" style="padding:24px;">Aucune notification pour l\'instant. Dès que le fournisseur modifie la carte de ce restaurant, elle apparaît ici.</div>';
    } else {
      html += '<div class="table-container"><table><thead><tr><th>Reçue le</th><th>Type</th><th>État</th><th>Durée</th><th>Résultat</th></tr></thead><tbody>';
      events.forEach(function (ev) {
        var dureeMs = ev.resultat && ev.resultat.duree_ms;
        var duree = dureeMs != null ? (Number(dureeMs) / 1000).toFixed(1).replace('.', ',') + ' s' : '–';
        var detail;
        if (ev.etat === 'erreur') detail = '<span style="color:var(--err);">' + esc(ev.message_erreur || 'Erreur sans détail') + '</span>';
        else if (ev.etat === 'ignore') detail = '<span style="color:var(--muted);">' + esc(ev.message_erreur || 'Ignorée') + '</span>';
        else if (estBloquee(ev)) detail = '<span style="color:var(--err);">Aucun résultat enregistré</span>';
        else if (ev.etat === 'traite') detail = esc(resumeResultat(ev.resultat) || 'Synchro terminée');
        else detail = '<span style="color:var(--muted);">Synchro en cours…</span>';
        html += '<tr title="Identifiant de la notification : ' + esc(ev.event_id) + '">' +
          '<td>' + esc(typeof formatDate === 'function' ? formatDate(ev.recu_le) : ev.recu_le) + '</td>' +
          '<td>' + esc(libelleType(ev.type_evenement)) + '</td>' +
          '<td>' + badgeEtat(ev) + '</td>' +
          '<td>' + esc(duree) + '</td>' +
          '<td class="notif-detail">' + detail + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    corps.innerHTML = html;
  }

  // Charge les données, met à jour les pastilles et, si le bloc est affiché, son contenu
  async function actualiser() {
    if (enCours) return;
    enCours = true;
    try {
      var bid = BUSINESS_ID;
      var events = await charger();
      if (bid !== BUSINESS_ID) return;   // le restaurant a changé pendant la lecture
      var situation = Array.isArray(events) ? evaluer(events, bid) : { niveau: 'inconnu', dernier: null };
      appliquerPastilles(situation);
      afficherBloc(events, situation);
    } finally {
      enCours = false;
    }
  }
  window.__notifActualiser = actualiser;

  function injecterBloc() {
    var zone = document.getElementById('api-contenu');
    if (!zone) return;
    if (zone.querySelector('.no-data') || zone.querySelector('.loading')) return;   // la page Connexion API n'a pas pu se charger
    if (zone.querySelector('details.notif-fournisseur')) return;
    var d = document.createElement('details');
    d.className = 'notif-fournisseur';
    if (notifOuvert) d.open = true;
    d.innerHTML = '<summary><span>Notifications du fournisseur</span><span class="notif-etat" id="notif-etat"></span></summary>' +
      '<div class="notif-corps" id="notif-corps"><div class="loading">🔄 Chargement…</div></div>';
    d.addEventListener('toggle', function () { notifOuvert = d.open; });
    zone.appendChild(d);
    actualiser();
  }

  // ---------- Branchement sur le back-office existant (sans le modifier) ----------
  function apres(nom, action) {
    var original = window[nom];
    if (typeof original !== 'function') { console.warn('notifications-fournisseur : fonction introuvable', nom); return; }
    window[nom] = async function () {
      var resultat = await original.apply(this, arguments);
      try { action(); } catch (e) { console.warn('notifications-fournisseur', nom, e); }
      return resultat;
    };
  }

  function demarrerRafraichissement() {
    if (minuteur) return;
    minuteur = setInterval(function () {
      var tableau = document.getElementById('dashboard');
      if (document.hidden || !tableau || !tableau.classList.contains('show')) return;
      actualiser();
    }, INTERVALLE_MS);
  }

  apres('showDashboard', function () { demarrerRafraichissement(); actualiser(); });
  apres('onChangeBusiness', function () { actualiser(); });
  apres('majPastillesParam', function () { actualiser(); });     // la fonction d'origine remet les pastilles à zéro : on réapplique l'alerte
  apres('chargerConnexionApi', function () { injecterBloc(); });
})();
