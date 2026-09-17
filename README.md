# ⚡ Circuits — simulateur interactif

Outil web (dans l'esprit d'EveryCircuit) pour construire des circuits par glisser-déposer, les simuler en
temps réel et **voir les électrons circuler**. Pensé pour expérimenter pendant un cours de circuits.

## Démarrer

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests unitaires du moteur (vitest)
npm run build      # version statique dans dist/
```

Aucun serveur n'est nécessaire : `dist/` peut être ouvert tel quel ou hébergé sur GitHub Pages.

## Fonctionnalités

- **Composants** : pile (CC), source CA, source v(t) / i(t) définie par une fonction du temps, source de courant,
  sources dépendantes (VCVS, VCCS, CCVS, CCCS), résistance, condensateur, bobine, diode, DEL, ampoule,
  interrupteur, masse, voltmètre, ampèremètre.
- **Édition** : glisser-déposer depuis la palette, fils tirés depuis les terminaux, rotation (R), duplication (Ctrl+D),
  suppression (Suppr), annuler / rétablir (Ctrl+Z / Ctrl+Y), zoom à la molette, sauvegarde automatique et export JSON.
- **Simulation** : analyse nodale modifiée en transitoire (méthode trapézoïdale), diodes par Newton-Raphson,
  vitesse réglable de ×0,0001 à ×10 pour observer aussi bien un RC lent qu'un signal à 60 Hz.
- **Animation** : les électrons se déplacent à une vitesse qui suit le courant sur une échelle logarithmique
  plafonnée (lisible du µA à l'ampère, sans effet stroboscopique), du − vers le +
  (ou dans le sens conventionnel au choix) ; des flèches indiquent le sens conventionnel du courant ; les fils sont
  colorés selon la tension ; ampoules et DEL s'allument.
- **Mesures** : survol pour lire V, I et P ; voltmètre / ampèremètre ; affichage de V, I, P sur chaque composant, chaque
  grandeur avec sa couleur. V et I sont signés par rapport à la flèche de référence du composant (flèche creuse,
  + à la queue, − à la pointe), que l'on peut inverser (touche I) comme on choisit un sens de courant avant d'analyser
  un circuit ; les flèches pleines montrent le sens réel (conventionnel ou électrons, selon l'option).
- **Oscilloscope** : tracé de la tension, du courant, de la puissance ou de la résistance (V/I) de n'importe quel
  composant en fonction du temps, fenêtre réglable de 1 ms à 30 s.
- **Interface Material 3** : composants officiels [Material Web](https://github.com/material-components/material-web)
  (boutons, curseurs, champs, dialogues, menus, interrupteurs) et icônes Material Symbols copiées en SVG dans le dépôt.
- **Thème dynamique (Material You)** : le schéma de couleurs complet est généré avec
  `@material/material-color-utilities` à partir d'une couleur source (préréglages, couleur personnalisée ou aléatoire),
  d'un style (tonal, vif, expressif, neutre, monochrome…), d'un niveau de contraste et du mode clair / sombre /
  système. Le canevas, les icônes et l'oscilloscope suivent le thème. Bouton « palette » dans la barre supérieure.
- **Panneaux masquables** : la palette, les propriétés et l'oscilloscope se masquent / affichent depuis la barre
  supérieure, leur bouton de fermeture ou les touches 1, 2, 3 ; la disposition est mémorisée. Sur écran étroit, les
  panneaux latéraux se superposent au canevas.
- **Fonctions du temps** : tout champ accepte un nombre avec préfixe SI (`4.7k`, `100u`) ou une expression de `t`,
  par exemple `5*sin(2*pi*60*t)`, `12*step(t-2m)`, `5*pulse(t, 10m, 0.25)`, `1k+500*sin(2*pi*t)`.
  Fonctions disponibles : `sin cos tan exp ln log10 sqrt abs sign floor min max pow mod step pulse square tri saw ramp expdecay`.

## Organisation du code

```
src/sim/model.ts     types, définitions des composants (terminaux, propriétés)
src/sim/netlist.ts   construction des nœuds (union-find), découpe des fils aux jonctions
src/sim/solver.ts    moteur MNA transitoire, sources dépendantes, courants dans les fils
src/sim/expr.ts      évaluateur d'expressions de t
src/sim/units.ts     préfixes SI
src/sim/examples.ts  circuits d'exemple
src/ui/app.ts        état global, historique, sauvegarde, boucle de simulation
src/ui/renderer.ts   rendu canvas (symboles, électrons, étiquettes)
src/ui/editor.ts     interactions souris / clavier
src/ui/panels.ts     palette, barre d'outils, propriétés, oscilloscope, dialogue de thème
src/ui/scope.ts      oscilloscope
src/ui/theme.ts      thème dynamique Material 3 (couleur source → variables --md-sys-color-*, palette canvas)
src/ui/layout.ts     panneaux masquables (état mémorisé, mode compact)
src/ui/material.ts   enregistrement des composants @material/web
src/ui/icons.ts      icônes Material Symbols (SVG dans src/ui/icons/)
src/ui/dom.ts        utilitaires DOM (sélecteur, filtrage des raccourcis, snackbar)
```

## Notes sur le moteur

- Le nœud de masse est la référence 0 V ; sans masse, le premier nœud est pris comme référence.
- Chaque nœud reçoit une conductance minimale (1 pS) vers la référence pour éviter les matrices singulières
  quand une partie du circuit est flottante.
- Les fils sont idéaux ; leur courant est réparti a posteriori en résolvant un laplacien par nœud
  (fils de même résistance par unité de longueur), ce qui permet d'animer les électrons même dans les boucles.
- Interrupteur fermé et ampèremètre sont des sources de 0 V, ce qui donne directement leur courant.
