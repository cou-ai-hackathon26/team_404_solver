# MediConnect — Integrated Healthcare Platform

MediConnect connects **patients, doctors, diagnostic centers, medical shops (pharmacies) and ambulance services** in one system, with an **admin** who verifies every provider.

Stack: Node.js 22 + Express + EJS (server-rendered), built-in `node:sqlite` database, Leaflet + OpenStreetMap for live maps. No build step and no external database to install.

---

## 1. Run it in VS Code

**Requirement:** Node.js **22.13 or newer** (check with `node -v`). Download the LTS version from https://nodejs.org.

1. Unzip `mediconnect.zip` and open the `mediconnect` folder in VS Code (*File → Open Folder*).
2. Open the terminal (*Terminal → New Terminal*) and run:
   ```bash
   npm install
   npm start
   ```
   `npm install` also creates your `.env` file.
3. Open **http://localhost:3000** and log in with a demo account below (email + password, no code needed).

The database is created and filled with demo data on the first start. A database from an older version is backed up automatically and rebuilt.

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-restart when you edit files |
| `npm run reset` | Delete all data and reload the demo data |
| `npm test` | End-to-end test of every portal and feature (128 checks, temporary database) |

Debugging: press **F5** and choose *Run MediConnect (debug)*.

---

## 2. Real email codes from your Gmail (one-time setup)

Verification codes are sent **once, at registration**. Patients, doctors and diagnostic centers get the code by **email**; medical shops and ambulances get it by **SMS** to their phone. After that, everyone logs in with just email and password.

`.env` is already set to send from **oliveahmmad96@gmail.com**. Gmail needs an *App Password*:

1. Open https://myaccount.google.com/security and turn on **2-Step Verification**.
2. Open https://myaccount.google.com/apppasswords, create a password named "MediConnect" and copy the 16 letters.
3. Paste it in `.env`: `SMTP_PASS=abcdabcdabcdabcd`, save, and restart with `npm start`.

The terminal then says `Email: sending real emails from oliveahmmad96@gmail.com`, and codes arrive in the inbox of whatever email address someone registers with. While `SMTP_PASS` is empty (or if Gmail rejects the login), codes are printed in the VS Code terminal and shown on the page, so the app still works.

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
- **Gmail: “Invalid login”** → use an App Password, not your normal Gmail password; 2-Step Verification must be on.
- **No location** → allow location in the browser; on `http://localhost` it is allowed.
- **No voice** → click anywhere on the page once (browsers block sound until you interact) and use “Test voice”.
- **Fresh demo data** → `npm run reset`.
