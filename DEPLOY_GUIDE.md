# Guide de Déploiement Officiel : MyEsther

## URL de Production Officielle
* **Serveur Relais & Web App** : `https://myesther-m7y9.onrender.com`
* **Dépôt GitHub Lié** : `https://github.com/walter1960/myesther` (Branche `master`)

---

## 1. Comment déployer la dernière version sur Render

Comme votre service Render est déjà connecté à votre GitHub :

1. Ouvrez votre terminal et poussez les dernières modifications :
```bash
git add .
git commit -m "RELEASE: MyEsther Ghost Edition - Vocaux, Lobby, Interopérabilité AES et Nouveau Logo"
git push origin master
```
2. Render va détecter le nouveau commit (`master`) et relancer automatiquement le déploiement en 1 minute.
3. Dès que le statut passe à **Live (Vert)** sur votre Dashboard Render, le serveur est à jour !

---

## 2. Comment générer l'APK / AAB pour le Play Store

L'application Android est déjà configurée pour pointer vers `https://myesther-m7y9.onrender.com`.

Dans le dossier `MyEsther-Android/` :
```bash
# Pour générer le bundle de publication Google Play Store (.aab) :
./gradlew bundlePlayStoreRelease

# Ou pour générer l'APK direct à tester sur votre téléphone :
./gradlew assemblePlayStoreRelease
```
Le fichier généré sera dans `app/build/outputs/`.
Il ne vous reste plus qu'à le téléverser sur la Google Play Console !
