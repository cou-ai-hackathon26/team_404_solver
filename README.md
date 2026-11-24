# MediConnect — Integrated Healthcare Platform

MediConnect connects **patients, doctors, diagnostic centers, medical shops (pharmacies) and ambulance services** in one system, with an **admin** who verifies every provider.

Stack: Node.js 22 + Express + EJS (server-rendered), built-in `node:sqlite` database, Leaflet + OpenStreetMap for live maps. No build step and no external database to install.

---

## 1. Run it

**Easiest (Windows):** unzip, then double-click **`START.bat`**. It installs everything the first time, asks once for your Gmail App Password (paste it and press Enter), sends you a test email, starts the app and opens http://localhost:3000.

**In VS Code:**

**Requirement:** Node.js **22.13 or newer** (check with `node -v`). Download the LTS version from https://nodejs.org.

1. Unzip `mediconnect.zip` (right-click → *Extract All*) and open the extracted `mediconnect` folder, the one that contains `package.json`, in VS Code (*File → Open Folder*).
2. Open the terminal (*Terminal → New Terminal*) and run:
   ```bash
   npm install
   npm start
   ```
   Then put your email and App Password in `.env` (section 2).
3. Open **http://localhost:3000** and log in with a demo account below (email + password, no code needed).

The database is created and filled with demo data on the first start. A database from an older version is backed up automatically and rebuilt.

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-restart when you edit files |
| `npm run reset` | Delete all data and reload the demo data |
| `npm run mailtest` | Send yourself a test email and show what is wrong if it fails |
| `npm test` | End-to-end test of every portal and feature (128 checks, temporary database) |

Debugging: press **F5** and choose *Run MediConnect (debug)*.

---


## Language switch (English / বাংলা)

Every page has a **বাংলা / English** button in the top-right corner (on the login and register pages it floats in the top-right corner).

- Click **বাংলা** to see the whole portal in Bangla: menus, buttons, forms, placeholders, messages, notifications, statuses, dates and units.
- Click **English** to switch back.
- The choice is remembered in the browser, so every page and the next visit open in the same language.
- Nothing on the server changes, so all features work exactly the same in both languages. Names, chat messages and other text that users type are shown as written.

Files: `public/js/i18n.js` (the switch), `public/js/i18n-bn.js` (the Bangla dictionary, about 2,000 phrases), `public/js/i18n-boot.js` (avoids a flash of English when Bangla is selected). To add or fix a translation, edit `i18n-bn.js`: the key is the exact English text and the value is the Bangla text.

## 2. Real email codes from your Gmail (one-time setup)

Verification codes are sent **once, at registration** (and for "Forgot password"). Patients, doctors and diagnostic centers get the code by **email**. Medical shops and ambulances get it by **SMS**; until real SMS is set up, their code is **also emailed** to them. After that, everyone logs in with just email and password.

You only fill in **two lines** at the top of `.env` (the file next to `package.json`):

```env
SMTP_USER=your-email@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
```

1. Turn on **2-Step Verification**: https://myaccount.google.com/signinoptions/twosv
2. Create an **App Password** (name it "MediConnect"): https://myaccount.google.com/apppasswords. Copy the 16 letters into `SMTP_PASS` (spaces are fine). Your normal Gmail password does **not** work.
3. Save `.env`, stop the server (Ctrl+C) and run `npm start` again.
4. Check it: `npm run mailtest` sends a test email to yourself and says exactly what is wrong if it fails.

The terminal then says `Email: ON. Verification codes are emailed from ...`, and codes arrive in the inbox of whatever address someone registers with (tell users to check Spam too). Gmail settings (smtp.gmail.com, port 465) are filled in automatically; if your network blocks port 465 the app switches to 587 by itself. While the email is not set up or fails, codes are printed in the VS Code terminal and shown on the page, so sign-up still works.

> বাংলায়: `.env` ফাইলের একদম উপরে শুধু `SMTP_USER` (তোমার Gmail) আর `SMTP_PASS` (Google-এর ১৬ অক্ষরের App Password) বসাও, সেভ করো, সার্ভার আবার চালু করো। তারপর `npm run mailtest` দিয়ে পরীক্ষা করো।

**SMS:** with `SMS_PROVIDER=console` the code is printed in the terminal. For real SMS in Bangladesh set `SMS_PROVIDER=bulksmsbd`, `SMS_API_KEY` and `SMS_SENDER_ID` from bulksmsbd.net (or use `twilio` with the Twilio settings).

---

## 3. Demo accounts

Password for every account: **`Password123`**

| Role | Email |
|---|---|
| Patient | `patient@mediconnect.local` (Rahim Uddin) |
| Doctor | `dr.farhana@mediconnect.local` (Cardiology, live location on), `dr.nusrat@`, `dr.imran@`, `dr.sabrina@` (Dermatology), `dr.mahmud@` (Orthopedics), `dr.sharmin@` (new Dermatology), `dr.rafi@` (Dentistry), `dr.nabila@` (Eye) … all `@mediconnect.local` |
| Diagnostic center | `center@mediconnect.local`, `center2@…` (Lifeline), `center4@…` (Medinova, 25% off) |
| Medical shop | `pharmacy@mediconnect.local` (Green Cross), `pharmacy2@…`, `pharmacy3@…` |
| Ambulance | `ambulance@mediconnect.local`, `ambulance2@…` (ICU), `ambulance3@…`, `ambulance4@…` (offline) |
| **Admin** | **`admin@mediconnect.local`** |

Waiting for admin approval: `dr.tanvir@`, `dr.salma@`, `center3@`, `pharmacy4@`, `ambulance5@`.

---

## 4. Features

| Feature | Where | How it works |
|---|---|---|
| **Sign-up by account type** | `/register` | First page shows 5 boxes: Patient, Doctor, Diagnostic Center, Medical Shop, Ambulance. The next page asks only what that type needs, plus license documents for providers. |
| **Verify once, then simple login** | Registration | OTP by email (patient, doctor, center) or SMS (medical shop, ambulance) only at registration. Login is email + password. |
| **AI doctor match in Bangla or English** | Patient → Find a Doctor | Bangla, English and Banglish symptoms (“হাতের হাড় ভেঙে গেছে” → Orthopedics, “চামড়ায় চুলকানি” / “skin problem” → Dermatology, “দাঁতে ব্যথা” → Dentistry). With `ANTHROPIC_API_KEY`, Claude picks the specialty. Newly approved doctors appear automatically; the admin can set any doctor’s specialty. |
| **Live location & distance** | Find a Doctor, doctor page | Map shows you (live GPS) and the doctor (live location if the doctor turns sharing on, else the chamber) with distance and travel time. |
| **See fee, book a free slot** | Doctor page | Fee shown up front. Click an available slot → doctor gets a notification → **Approve** or **Delete** → patient is notified. |
| **Doctor chat** | Doctor page → “Send chat request” | Patient sends a request; messaging opens only after the doctor accepts. Live updates. |
| **Health AI chatbot** | Patient → Health AI | First-aid advice in Bangla/English (headache, fever, cold, gastric, diarrhoea, burns, cuts, sprains, toothache, rash, stress, BP, low sugar …) with warning signs. Emergencies → 999. Claude answers when an API key is set. |
| **Search several tests at once** | Medical Tests → Compare centers | Pick all your tests; centers are sorted by nearest, lowest total or biggest discount, with per-test discounted prices. Book all in one click. Centers set discounts per test. |
| **Ambulance** | Patient → Ambulance; ambulance portal | Owners register, get verified, go online and share live GPS. Patients see nearby ambulances on a live map with distance, ETA and fare, request one, and track it until it arrives. |
| **Health analysis + prediction** | Patient → Health Analysis (AI) | Upload lab reports (PDF/photo) or import center reports. Values are read automatically (hemoglobin, sugar, HbA1c, cholesterol, LDL/HDL, creatinine, TSH, BP …), shown as monthly bar charts against normal ranges, with a health score and next-month prediction. |
| **Medicine reminders with voice** | Patient → Medicine Reminders | Enter medicine, dose, times per day and times. Choose device notification, voice (“এখন আপনার ওষুধ খাওয়ার সময় হয়েছে”) or both. Keep MediConnect open in a browser tab. |
| **Medicine shop** | Patient → Medicine Shop | Add medicines to a cart → pharmacies that have all of them, nearest / cheapest / best discount, unit and 10-piece prices → checkout with live location, **Regular or Emergency** delivery, and payment by **Cash on delivery, bKash/Nagad/Rocket/Upay, card or bank** (sandbox, no real money). |
| **Live stock** | Pharmacy → Live Stock | Stock and “sold” update when orders are accepted or counter sales are recorded; the page refreshes live. Shop-wide and per-medicine discounts, emergency delivery fee. |
| **Blood bank (4-month rule)** | Blood Bank | Donors register and record each donation date; they are hidden for 4 months after donating. Search by blood group, hospital and patient name to see eligible donors with phone numbers, or post a request to notify them. |
| Also | — | Appointments, prescriptions, test bookings, report upload and sharing, record-access control, order tracking, pharmacy reviews, health readings, admin verification and audit log. |

Maps need internet for the map tiles. Voice uses the browser’s speech engine; if no Bangla voice is installed, it speaks English.

---

## 5. Configuration (`.env`)

| Setting | Meaning |
|---|---|
| `PORT` | Web server port (3000) |
| `SMTP_*`, `MAIL_FROM` | Gmail sending (see section 2) |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID` | SMS for medical shops and ambulances |
| `ANTHROPIC_API_KEY` | Optional: Claude for the Health AI and doctor matching |
| `DEV_SHOW_OTP` | Show the code on the page while email/SMS is in console mode |
| `TZ` | Time zone (Asia/Dhaka) |

---

## 6. Project structure

```
src/
  server.js, config.js, db.js, seed.js, helpers.js, stats.js
  middleware/core.js          auth, roles, CSRF, sidebar
  routes/  auth, common, patient, doctor, center, pharmacy, ambulance, chat, blood, admin
  services/ otp, mailer, sms, recommender (AI match), firstaid, assistant, analysis,
            reminders, schedule, blood, reviews, ocr, notify, audit, geo …
views/     EJS pages per portal + partials (stickers = animated medical icons)
public/    css/style.css, css/motion.css, js/app.js, js/maps.js
tests/smoke.js
```

## 7. Troubleshooting

- **Node too old / `node:sqlite` missing** → install Node.js 22 LTS.
- **Email not arriving** → run `npm run mailtest`; it prints the exact problem and fix. Check the Spam folder too.
- **Gmail: “Invalid login” / EAUTH** → use an App Password, not your normal Gmail password; 2-Step Verification must be on. University or office Google accounts may block it: use a personal Gmail.
- **App Password page says “not available”** → 2-Step Verification is off, or the account is a school/work account that does not allow it.
- **Project folder inside another folder** (`mediconnect\mediconnect`) → open and run the folder that contains `package.json`.
- **No location** → allow location in the browser; on `http://localhost` it is allowed.
- **No voice** → click anywhere on the page once (browsers block sound until you interact) and use “Test voice”.
- **Fresh demo data** → `npm run reset`.

---

## MCP server (for AI agents)

MediConnect also runs as an **MCP server**, so any MCP client (Claude Desktop, Cursor, another agent) can use its read-only AI tools. No patient records are exposed.

```bash
npm run mcp
```

Tools: `find_specialist` (Bangla/English/Banglish symptoms → specialties + emergency red flags), `search_doctors` (verified doctors ranked by experience, availability, distance and fee), `first_aid` (bilingual first-aid knowledge base), `list_specialties`. Transport: stdio.

Claude Desktop config (`claude_desktop_config.json`):
```json
{ "mcpServers": { "mediconnect": { "command": "node", "args": ["C:/path/to/mediconnect/mcp/server.js"] } } }
```

## Hackathon challenges (COU Technova 2026)

**1. Caregiver proxy on a shared timeline.** A new **Caregiver** account type (Register → Caregiver) has its own portal. A patient invites a caregiver from **Caregivers & Timeline**, chooses exactly what to share (medicine reminders, vitals, reports) and whether the caregiver may act for them, and ticks a consent box; the invite stores a consent receipt. Nothing is shared until the caregiver accepts, and the patient can change permissions or revoke at any time.
- **Care dashboard** (caregiver home): everyone they look after with a red/amber/green status, missed doses, abnormal vitals, medicine-safety alerts, adherence and "new since your last visit", plus one-tap "Mark taken", Call and 999.
- **Shared timeline**: doses, vitals, reports, appointments and care notes in one feed (filters, 3–30 days, NEW markers). The caregiver can mark doses and log readings (if allowed); every action shows "by <caregiver>", notifies the patient and is audit-logged.
- **Automatic alerts**: caregivers are notified when a dose is missed by over an hour or a dangerous reading is logged.
- Demo: click **Caregiver** on the login page (Tania Rahman looks after Rahim and her father Kamal). Code: `src/services/caregivers.js`, `src/routes/care.js`, `views/care/`.

**2. The chatbot abstains when records and a drug-interaction rule disagree.** `src/services/interactions.js` holds fixed drug-interaction rules (drug + drug, and drug + lab value such as high creatinine). Before the Health AI answers, it checks the medicines in the patient's own records (prescriptions, active reminders, lab results) against those rules. If the records say "take it" but a rule says "don't combine", neither Claude nor the built-in answers reply: the bot explains the conflict, sends the patient to their doctor or pharmacist, and the event is written to the audit log. The same alert appears on the shared timeline for the caregiver. Demo: as Rahim, ask "Can I take my omeprazole with clopidogrel?" or "Can I take ibuprofen?".

Tests: `npm test` (162 checks, including both challenges).
