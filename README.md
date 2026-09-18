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
  sources dépendantes (VCVS, VCCS, CCVS, CCCS, et sources v = f(i, v) / i = f(i, v) définies par une expression
  des grandeurs d'autres composants, par exemple `2*i_R1`), résistance, condensateur, bobine, diode, DEL, ampoule,
  interrupteur, masse, voltmètre, ampèremètre.
- **Édition** : glisser-déposer depuis la palette, fils tirés depuis les terminaux, rotation (r), duplication (Ctrl+D),
  suppression (Suppr / x), annuler / rétablir (u / Ctrl+R), zoom à la molette, sauvegarde automatique et export JSON.
- **Câblage élastique** : les fils sont des segments, mais l'éditeur les manipule comme un tout. Déplacer un composant
  ré-achemine ses fils (orthogonaux, en contournant les autres composants et sans toucher les fils étrangers) ; glisser un
  fil déplace tout le chemin de segments reliés, les voisins suivent et les terminaux quittés restent raccordés (Alt pour
  détacher) ; glisser une extrémité déplace la jonction. Pivoter deux fois (r r) retourne un composant sur place : ses
  fils changent simplement de terminal, sans court-circuit, et r r r r revient exactement à l'état initial. Les segments
  alignés bout à bout sont fusionnés.
- **Tout au clavier (façon vim)** : curseur de grille `h j k l` (majuscules ×5), `a` + lettre pose un composant sous le
  curseur (`a r` résistance, `a v` pile, `a x e` VCVS…), `w` trace un fil (un second `w` pose le segment et enchaîne,
  Entrée termine), `x` supprime sous le curseur, `r` / `R` pivotent, `i` inverse la référence, `t` bascule un
  interrupteur, `e` ou Entrée ouvre la valeur (Échap ramène au canevas), `y` / `p` copient-collent, `.` répète, `m` passe en
  mode déplacement (h j k l déplacent la sélection), Tab passe au composant suivant, `s` simule, `<` `>` règlent la
  vitesse, `zz` centre, `f` ajuste, `0` `+` `-` zooment, `1` `2` `3` masquent les panneaux. La touche maître **Espace**
  ouvre un menu dont les sous-menus (`a` ajouter, `e` édition, `s` simulation, `v` vue, `p` panneaux, `o` oscilloscope,
  `f` fichier) s'affichent au fur et à mesure (panneau « which-key ») ; `:` ouvre une palette de commandes où l'on tape
  le nom d'une action ou d'un composant (« R1 » le sélectionne) ; `?` liste tous les raccourcis. L'indicateur en bas du
  canevas montre le mode courant (NORMAL, FIL, DÉPLACER, SAISIE, ATTENTE…).
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
  supérieure, leur bouton de fermeture ou les touches 1, 2, 3 (ou Espace p) ; la disposition est mémorisée. Sur écran étroit, les
  panneaux latéraux se superposent au canevas.
- **Fonctions du temps** : tout champ accepte un nombre avec préfixe SI (`4.7k`, `100u`) ou une expression de `t`,
  par exemple `5*sin(2*pi*60*t)`, `12*step(t-2m)`, `5*pulse(t, 10m, 0.25)`, `1k+500*sin(2*pi*t)`.
  Fonctions disponibles : `sin cos tan exp ln log10 sqrt abs sign floor min max pow mod step pulse square tri saw ramp expdecay`.
  Les grandeurs d'autres composants sont accessibles par `i_R1` (courant, sens de la flèche de référence) et `v_R1`
  (tension) ; la multiplication implicite est acceptée (`2 i_R1`). Le solveur linéarise ces dépendances à chaque
  itération de Newton (dérivées numériques), ce qui résout exactement les expressions linéaires en une passe et fait
  converger les non linéaires.

## Organisation du code

```
src/sim/model.ts     types, définitions des composants (terminaux, propriétés)
src/sim/netlist.ts   construction des nœuds (union-find), découpe des fils aux jonctions, fusion des segments alignés
src/sim/wiring.ts    câblage : routage orthogonal avec obstacles, déplacement élastique des jonctions, chemins de fils
src/sim/solver.ts    moteur MNA transitoire, sources dépendantes, courants dans les fils
src/sim/expr.ts      évaluateur d'expressions de t
src/sim/units.ts     préfixes SI
src/sim/examples.ts  circuits d'exemple
src/ui/app.ts        état global, historique, sauvegarde, boucle de simulation
src/ui/renderer.ts   rendu canvas (symboles, électrons, étiquettes)
src/ui/editor.ts     interactions souris / clavier (curseur de grille, glisser élastique, fil au clavier, modes)
src/ui/keys.ts       séquences de touches, panneau which-key, palette de commandes, tableau d'aide
src/ui/commands.ts   toutes les commandes et leurs raccourcis (touche maître Espace et sous-menus)
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
