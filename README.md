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
  (ou dans le sens conventionnel au choix) ; les fils sont colorés selon la tension ; ampoules et DEL s'allument.
- **Mesures** : survol pour lire V, I et P ; voltmètre / ampèremètre ; affichage de V, I, P sur chaque composant.
- **Oscilloscope** : tracé de la tension, du courant, de la puissance ou de la résistance (V/I) de n'importe quel
  composant en fonction du temps, fenêtre réglable de 1 ms à 30 s.
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
src/ui/panels.ts     palette, barre d'outils, propriétés, oscilloscope
src/ui/scope.ts      oscilloscope
```

## Notes sur le moteur

- Le nœud de masse est la référence 0 V ; sans masse, le premier nœud est pris comme référence.
- Chaque nœud reçoit une conductance minimale (1 pS) vers la référence pour éviter les matrices singulières
  quand une partie du circuit est flottante.
- Les fils sont idéaux ; leur courant est réparti a posteriori en résolvant un laplacien par nœud
  (fils de même résistance par unité de longueur), ce qui permet d'animer les électrons même dans les boucles.
- Interrupteur fermé et ampèremètre sont des sources de 0 V, ce qui donne directement leur courant.
