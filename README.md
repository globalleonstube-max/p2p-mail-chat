<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>
Варианты описания (Description)


Вариант 1: Технический и структурированный (Для разработчиков)

Лидер-абзац: "A decentralized P2P chat client and core daemon written in Go, utilizing IMAP/SMTP protocols as a global transport layer with IMAP IDLE and smart message buffering."
(Перевод для русскоязычного readme: Децентрализованный P2P-чат клиент и фоновое ядро на Go, использующее протоколы IMAP/SMTP в качестве глобального транспорта с поддержкой IMAP IDLE и умной буферизацией.)

Вариант 2: Продуктовый и концептуальный (Хорош для портфолио)

"Serverless, decentralized messaging over standard email infrastructure. A production-ready Go daemon with a non-blocking CLI interface and custom Pub/Sub event router."
(Перевод: Бессерверный децентрализованный обмен сообщениями поверх стандартной инфраструктуры электронной почты. Готовое к работе ядро на Go с неблокирующим CLI и кастомным Pub/Sub роутером событий.)

Вариант 3: Короткий и интригующий

"Turning your everyday email inbox into a secure, decentralized P2P communication node. Written in Go."
(Перевод: Превратите ваш обычный почтовый ящик в безопасный децентрализованный узел P2P-связи. Написано на Go.)



# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/38d848a8-73b2-41af-a94b-61b68f6b45d6

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
