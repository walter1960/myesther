# 🚀 Guide de Mise en Ligne : MyEsther sur Render.com

Ce guide vous explique comment rendre votre application accessible partout dans le monde en moins de 5 minutes.

## Étape 1 : Mettre le code sur GitHub
1. Connectez-vous sur [GitHub.com](https://github.com/).
2. Créez un nouveau dépôt (Repository) nommé `myesther`.
3. Allez dans le dossier `/home/walter/Trainings/Artificial Intelligence/stage URYA/URYA_Neural_Cryptography_Complete/PROJET_URYA_FINAL/MyEsther_Production` sur votre ordinateur.
4. Glissez-déposez **tout le contenu** de ce dossier (le fichier `server.py`, le dossier `frontend`, etc.) dans votre dépôt GitHub.
5. Cliquez sur **"Commit changes"**.

## Étape 2 : Lier à Render.com
1. Allez sur [Render.com](https://render.com/) et créez un compte gratuit (utilisez votre compte GitHub pour aller plus vite).
2. Cliquez sur le bouton bleu **"New +"** puis choisissez **"Web Service"**.
3. Sélectionnez votre dépôt GitHub `myesther`.
4. Dans la configuration, remplissez ces champs :
   - **Name :** `myesther`
   - **Runtime :** `Python 3`
   - **Build Command :** `pip install -r requirements.txt`
   - **Start Command :** `gunicorn -k eventlet -w 1 server:app`
5. Cliquez sur **"Create Web Service"**.

## Étape 3 : C'est en ligne !
Render va prendre 1 ou 2 minutes pour tout installer. Une fois terminé, il vous donnera une adresse du type :
`https://myesther-votre-nom.onrender.com`

> [!TIP]
> Votre application sera alors accessible sur PC, Android et iPhone 24h/24 !

> [!IMPORTANT]
> Sur Render (version gratuite), le serveur s'endort après 15 minutes d'inactivité. Il suffit de réouvrir le lien pour qu'il se réveille en quelques secondes.
