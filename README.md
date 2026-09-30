# Mes emprunts

Application web installable (PWA) pour savoir si un livre a déjà été emprunté à la bibliothèque.

- Scan de l'ISBN à la caméra (Chrome Android), ou recherche par titre / auteur / tome
- Infos du livre récupérées automatiquement (Google Books, puis Open Library)
- Emprunts par membre de la famille, statut lu / pas lu, 👍 / 👎
- Onglet Séries : prochain tome à emprunter, tomes manquants, séries abandonnées
- Fonctionne hors ligne ; les données restent sur le téléphone (export / restauration en JSON)
- Import CSV de l'historique de la bibliothèque (colonnes titre, auteur, ISBN, date)

## Tester en local

```sh
python3 -m http.server 8000   # puis ouvrir http://localhost:8000
```

## Mettre en ligne gratuitement (GitHub Pages)

1. Pousser ce dépôt sur GitHub.
2. Settings → Pages → Source : branche `main`, dossier `/`.
3. Sur le téléphone, ouvrir `https://<utilisateur>.github.io/<dépôt>/` dans Chrome → menu ⋮ → « Installer l'application ».

La caméra ne fonctionne qu'en HTTPS (ou sur localhost).
Après une modification des fichiers, changer `CACHE` dans `sw.js` pour forcer la mise à jour.
