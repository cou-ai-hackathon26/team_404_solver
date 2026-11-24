// First-aid and self-care advice for common complaints, in Bangla and English.
// Used by the Health AI chatbot when no API key is set (and as safety context with one).
// Advice is general and safe; every answer says when to see a doctor.
const TOPICS = [
  {
    keys: ['headache', 'head ache', 'migraine', 'matha betha', 'মাথা ব্যথা', 'মাথাব্যথা', 'মাথা ধরে', 'মাইগ্রেন', 'matha batha', 'mathabetha', 'mathabatha', 'matha bethа', 'matha dhore', 'mathay betha', 'mathay batha', 'মাথায় ব্যথা', 'মাথা ঘোরা', 'মাথা ঘুরছে', 'মাথা ধরা'],
    specialty: 'Neurology',
    en: `For a headache you can try first:
• Drink 1–2 glasses of water; dehydration is a common cause.
• Rest in a quiet, dim room for 20–30 minutes; avoid screens.
• A cool or warm cloth on the forehead or neck.
• Paracetamol (e.g. Napa 500 mg) as per the pack, if it suits you. Do not exceed the daily limit.
• Eat something if you skipped a meal, and sleep enough.
See a doctor if: it is the worst headache of your life, comes with fever and stiff neck, weakness, confusion, vision loss, after a head injury, or keeps coming back.`,
    bn: `মাথা ব্যথায় প্রথমে যা করতে পারেন:
• ১–২ গ্লাস পানি পান করুন; পানিশূন্যতা একটি সাধারণ কারণ।
• ২০–৩০ মিনিট শান্ত, আলো কম এমন ঘরে বিশ্রাম নিন; মোবাইল/স্ক্রিন এড়িয়ে চলুন।
• কপালে বা ঘাড়ে ঠান্ডা বা হালকা গরম কাপড় দিন।
• প্রয়োজনে প্যারাসিটামল (যেমন নাপা ৫০০ মি.গ্রা.) প্যাকেটের নিয়ম অনুযায়ী খেতে পারেন; দৈনিক সীমা ছাড়াবেন না।
• না খেয়ে থাকলে কিছু খান এবং পর্যাপ্ত ঘুমান।
ডাক্তার দেখান যদি: জীবনের সবচেয়ে তীব্র ব্যথা হয়, জ্বর ও ঘাড় শক্ত হয়ে যায়, দুর্বলতা, বিভ্রান্তি বা চোখে ঝাপসা দেখেন, মাথায় আঘাতের পর হয়, বা বারবার হয়।`,
  },
  {
    keys: ['fever', 'temperature', 'jor', 'jwor', 'জ্বর', 'গা গরম', 'jwr', 'jor ase', 'jor hoise', 'gaye jor', 'gay jor', 'জ্বর আসছে', 'জ্বর এসেছে', 'গায়ে জ্বর', 'শরীর গরম', 'তাপমাত্রা'],
    specialty: 'General Medicine',
    en: `For fever:
• Rest and drink plenty of fluids: water, ORS, soup, fruit juice.
• Paracetamol as per the pack to bring the temperature down. Avoid aspirin/ibuprofen if dengue is possible.
• Sponge the body with normal (not cold) water; wear light clothes.
• Check the temperature every 4–6 hours.
See a doctor if: fever lasts more than 3 days, is above 103°F (39.4°C), or comes with rash, bleeding, severe headache, breathing trouble, confusion or repeated vomiting. During dengue season, get an NS1/CBC test.`,
    bn: `জ্বর হলে:
• বিশ্রাম নিন এবং প্রচুর তরল খান: পানি, স্যালাইন, স্যুপ, ফলের রস।
• তাপমাত্রা কমাতে প্যাকেটের নিয়মে প্যারাসিটামল খেতে পারেন। ডেঙ্গুর সম্ভাবনা থাকলে অ্যাসপিরিন/আইবুপ্রোফেন খাবেন না।
• স্বাভাবিক (ঠান্ডা নয়) পানি দিয়ে শরীর মুছে দিন; হালকা কাপড় পরুন।
• ৪–৬ ঘণ্টা পরপর তাপমাত্রা মাপুন।
ডাক্তার দেখান যদি: ৩ দিনের বেশি জ্বর থাকে, ১০৩°F এর বেশি হয়, অথবা র‍্যাশ, রক্তপাত, তীব্র মাথাব্যথা, শ্বাসকষ্ট, বিভ্রান্তি বা বারবার বমি হয়। ডেঙ্গুর মৌসুমে NS1/CBC পরীক্ষা করান।`,
  },
  {
    keys: ['cold', 'cough', 'sore throat', 'runny nose', 'flu', 'sordi', 'kashi', 'সর্দি', 'কাশি', 'গলা ব্যথা', 'ঠান্ডা লেগেছে', 'sordi', 'kashi', 'kasi', 'thanda', 'gola betha', 'gola batha', 'nak diye pani', 'হাঁচি', 'নাক দিয়ে পানি', 'গলা খুসখুস', 'ঠান্ডা'],
    specialty: 'General Medicine',
    en: `For cold, cough or sore throat:
• Warm water with honey and lemon or ginger tea soothes the throat.
• Gargle with warm salt water 3–4 times a day.
• Steam inhalation for a blocked nose.
• Rest and drink warm fluids. Paracetamol helps body ache.
See a doctor if: cough lasts over 2 weeks, you cough blood, have breathing trouble, high fever, or chest pain.`,
    bn: `সর্দি, কাশি বা গলা ব্যথায়:
• কুসুম গরম পানিতে মধু ও লেবু, অথবা আদা চা গলাকে আরাম দেয়।
• দিনে ৩–৪ বার কুসুম গরম লবণ পানিতে গার্গল করুন।
• নাক বন্ধ থাকলে গরম পানির ভাপ নিন।
• বিশ্রাম নিন, গরম তরল খান। শরীর ব্যথায় প্যারাসিটামল সাহায্য করে।
ডাক্তার দেখান যদি: ২ সপ্তাহের বেশি কাশি থাকে, কাশির সাথে রক্ত আসে, শ্বাসকষ্ট, তীব্র জ্বর বা বুকে ব্যথা হয়।`,
  },
  {
    keys: ['stomach pain', 'stomach ache', 'acidity', 'gastric', 'heartburn', 'gas', 'pet betha', 'পেট ব্যথা', 'পেটে ব্যথা', 'গ্যাস', 'অ্যাসিডিটি', 'এসিডিটি', 'বুক জ্বালা', 'pet batha', 'pete betha', 'pete batha', 'pet kamrano', 'gastric er', 'ombol', 'buk jala', 'পেট কামড়', 'পেট ফাঁপা', 'অম্বল', 'হজমে সমস্যা', 'বদহজম'],
    specialty: 'Gastroenterology',
    en: `For acidity or stomach pain:
• Eat small, light meals; avoid oily, spicy food, tea/coffee and smoking.
• Don't lie down for 2–3 hours after eating.
• An antacid or omeprazole (as per the pack) can help acidity.
• Drink water; walk a little after meals.
See a doctor if: pain is severe or on the lower right side, with fever, vomiting blood, black stools, or lasts more than 2 days.`,
    bn: `গ্যাস্ট্রিক বা পেট ব্যথায়:
• অল্প অল্প করে হালকা খাবার খান; তেল-মশলা, চা/কফি ও ধূমপান এড়িয়ে চলুন।
• খাওয়ার পর ২–৩ ঘণ্টা শুয়ে পড়বেন না।
• অ্যান্টাসিড বা ওমিপ্রাজল (প্যাকেটের নিয়মে) গ্যাস্ট্রিকে সাহায্য করে।
• পানি পান করুন; খাওয়ার পর একটু হাঁটুন।
ডাক্তার দেখান যদি: তীব্র ব্যথা বা তলপেটের ডান দিকে ব্যথা হয়, জ্বর, রক্তবমি, কালো পায়খানা হয় বা ২ দিনের বেশি থাকে।`,
  },
  {
    keys: ['diarrhea', 'diarrhoea', 'loose motion', 'vomiting', 'potla paikhana', 'ডায়রিয়া', 'পাতলা পায়খানা', 'বমি', 'patla paikhana', 'paikhana', 'bomi', 'bomi bomi', 'vomit', 'ডায়রিয়া হয়েছে', 'পেট খারাপ', 'বমি বমি', 'বমি হচ্ছে'],
    specialty: 'Gastroenterology',
    en: `For diarrhoea or vomiting:
• Drink ORS (oral saline) after every loose stool; sip slowly if vomiting.
• Keep eating light food: rice, khichuri, banana, curd. Children should continue breastfeeding.
• Zinc tablets help children with diarrhoea (as advised).
• Wash hands and drink safe water.
See a doctor quickly if: there is blood in stool, high fever, no urine for 6+ hours, very weak or drowsy, sunken eyes, or it lasts more than 2 days.`,
    bn: `ডায়রিয়া বা বমিতে:
• প্রতিবার পাতলা পায়খানার পর খাবার স্যালাইন খান; বমি হলে অল্প অল্প করে চুমুক দিন।
• হালকা খাবার চালিয়ে যান: ভাত, খিচুড়ি, কলা, দই। শিশুকে বুকের দুধ খাওয়ানো চালিয়ে যান।
• শিশুদের ডায়রিয়ায় জিংক ট্যাবলেট উপকারী (পরামর্শ অনুযায়ী)।
• হাত ধুয়ে নিন, নিরাপদ পানি পান করুন।
দ্রুত ডাক্তার দেখান যদি: পায়খানায় রক্ত, তীব্র জ্বর, ৬ ঘণ্টার বেশি প্রস্রাব না হয়, খুব দুর্বল বা ঝিমুনি, চোখ বসে যায়, বা ২ দিনের বেশি থাকে।`,
  },
  {
    keys: ['burn', 'pura', 'পুড়ে', 'পোড়া', 'ছ্যাঁকা', 'puira', 'puire', 'pure geche', 'gorom pani', 'আগুনে পুড়', 'গরম পানি পড়ে'],
    specialty: 'General Medicine',
    en: `For a minor burn:
• Hold it under cool running water for 20 minutes right away.
• Remove rings or tight items near the area.
• Cover loosely with a clean cloth or cling film.
• Do NOT apply toothpaste, ice, butter or oil. Don't burst blisters.
Go to hospital if: the burn is large, deep, on the face/hands/genitals, from electricity or chemicals, or in a child or elderly person.`,
    bn: `হালকা পোড়ায়:
• সাথে সাথে ২০ মিনিট ঠান্ডা চলমান পানির নিচে রাখুন।
• আশেপাশের আংটি বা টাইট জিনিস খুলে ফেলুন।
• পরিষ্কার কাপড় দিয়ে আলগা করে ঢেকে দিন।
• টুথপেস্ট, বরফ, মাখন বা তেল লাগাবেন না। ফোস্কা গলাবেন না।
হাসপাতালে যান যদি: পোড়া বড় বা গভীর হয়, মুখ/হাত/যৌনাঙ্গে হয়, বিদ্যুৎ বা কেমিক্যাল থেকে হয়, অথবা শিশু বা বয়স্ক কেউ পুড়ে যায়।`,
  },
  {
    keys: ['cut', 'bleeding', 'wound', 'kete', 'কেটে', 'রক্ত পড়', 'ক্ষত', 'kata', 'kete geche', 'kete gese', 'kata geche', 'rokto', 'রক্ত পড়ছে', 'কাটা', 'কেটে গেছে', 'ছিলে গেছে'],
    specialty: 'General Medicine',
    en: `For a cut or bleeding:
• Press firmly on the wound with a clean cloth for 10 minutes without lifting.
• Raise the injured part above heart level.
• Once bleeding stops, wash with clean water and cover with a clean bandage.
• Get a tetanus injection if you haven't had one in 5 years.
Go to hospital if: bleeding won't stop after 10 minutes of pressure, the cut is deep or gaping, from a dirty/rusty object or animal bite.`,
    bn: `কেটে গেলে বা রক্ত পড়লে:
• পরিষ্কার কাপড় দিয়ে ক্ষতস্থানে ১০ মিনিট শক্ত করে চেপে ধরুন, মাঝে তুলবেন না।
• আঘাতের জায়গাটা হার্টের লেভেলের উপরে তুলে রাখুন।
• রক্ত বন্ধ হলে পরিষ্কার পানিতে ধুয়ে পরিষ্কার ব্যান্ডেজ দিন।
• ৫ বছরে টিটেনাস না দিয়ে থাকলে টিটেনাস ইনজেকশন নিন।
হাসপাতালে যান যদি: ১০ মিনিট চাপের পরও রক্ত না থামে, ক্ষত গভীর বা হা হয়ে থাকে, নোংরা/মরিচা ধরা জিনিস বা পশুর কামড়ে হয়।`,
  },
  {
    keys: ['sprain', 'twist', 'injury', 'fracture', 'broken', 'mochka', 'মচকে', 'মচকা', 'হাড় ভেঙে', 'ভেঙে গেছে', 'আঘাত', 'mochke', 'mochke geche', 'mochka khaise', 'vanga', 'venge', 'haddi', 'মচকে গেছে', 'পায়ে ব্যথা', 'হাতে ব্যথা', 'ফুলে গেছে'],
    specialty: 'Orthopedics',
    en: `For a sprain or suspected fracture:
• Rest the injured part and don't put weight on it.
• Ice wrapped in cloth for 15–20 minutes every 2–3 hours (first 48 hours).
• Light compression bandage and keep it raised.
• If a bone may be broken, keep it still with a splint (a stick/cardboard) and go to hospital for an X-ray.
Go now if: there is deformity, the bone shows, severe pain/swelling, numbness, or you can't move it.`,
    bn: `মচকে গেলে বা হাড় ভাঙার সন্দেহ হলে:
• আঘাতপ্রাপ্ত অংশে বিশ্রাম দিন, ভর দেবেন না।
• কাপড়ে মোড়ানো বরফ ১৫–২০ মিনিট করে ২–৩ ঘণ্টা পরপর দিন (প্রথম ৪৮ ঘণ্টা)।
• হালকা করে ব্যান্ডেজ বাঁধুন এবং উঁচু করে রাখুন।
• হাড় ভাঙতে পারে মনে হলে কাঠি/শক্ত কাগজ দিয়ে নড়াচড়া বন্ধ রাখুন (স্প্লিন্ট) এবং এক্স-রের জন্য হাসপাতালে যান।
এখনই যান যদি: অঙ্গ বেঁকে যায়, হাড় বের হয়ে আসে, তীব্র ব্যথা/ফোলা, অবশ লাগে বা নাড়াতে না পারেন।`,
  },
  {
    keys: ['toothache', 'tooth pain', 'dat betha', 'দাঁতে ব্যথা', 'দাঁত ব্যথা', 'dat batha', 'date betha', 'dant betha', 'দাঁতে ব্যাথা', 'মাড়ি ব্যথা'],
    specialty: 'Dentistry',
    en: `For toothache:
• Rinse with warm salt water; floss gently to remove stuck food.
• A cold pack on the cheek for 15 minutes.
• Paracetamol as per the pack for pain.
• Avoid very hot, cold or sweet food.
See a dentist if: pain lasts more than 2 days, with swelling, fever, pus or difficulty opening the mouth.`,
    bn: `দাঁতে ব্যথায়:
• কুসুম গরম লবণ পানিতে কুলি করুন; আটকে থাকা খাবার আস্তে বের করুন।
• গালে ১৫ মিনিট ঠান্ডা সেঁক দিন।
• ব্যথার জন্য প্যাকেটের নিয়মে প্যারাসিটামল।
• খুব গরম, ঠান্ডা বা মিষ্টি খাবার এড়িয়ে চলুন।
ডেন্টিস্ট দেখান যদি: ২ দিনের বেশি ব্যথা থাকে, ফোলা, জ্বর, পুঁজ হয় বা মুখ খুলতে কষ্ট হয়।`,
  },
  {
    keys: ['rash', 'itch', 'allergy', 'hives', 'chulkani', 'চুলকানি', 'চুলকায়', 'এলার্জি', 'অ্যালার্জি', 'র‍্যাশ', 'ফুসকুড়ি', 'alergi', 'elargi', 'allergi', 'chulkay', 'chulkani hocche', 'gaye chulkani', 'lal dag', 'এলার্জি হয়েছে', 'গায়ে চুলকানি', 'লাল দাগ', 'চামড়ায় চুলকানি'],
    specialty: 'Dermatology',
    en: `For itching, rash or mild allergy:
• Wash the area with plain water and mild soap; keep it dry.
• Cool compress; wear loose cotton clothes.
• An antihistamine such as cetirizine (as per the pack) can reduce itching.
• Avoid scratching and the suspected cause (new soap, food, cosmetic).
Get help now if: lips, face or tongue swell, or breathing becomes difficult. See a dermatologist if it spreads or lasts more than a week.`,
    bn: `চুলকানি, র‍্যাশ বা হালকা এলার্জিতে:
• জায়গাটা পরিষ্কার পানি ও মৃদু সাবান দিয়ে ধুয়ে শুকনো রাখুন।
• ঠান্ডা সেঁক দিন; ঢিলেঢালা সুতি কাপড় পরুন।
• সেটিরিজিন জাতীয় অ্যান্টিহিস্টামিন (প্যাকেটের নিয়মে) চুলকানি কমায়।
• চুলকাবেন না; সন্দেহজনক কারণ (নতুন সাবান, খাবার, কসমেটিক) এড়িয়ে চলুন।
এখনই সাহায্য নিন যদি: ঠোঁট, মুখ বা জিভ ফুলে যায় বা শ্বাস নিতে কষ্ট হয়। ছড়িয়ে পড়লে বা এক সপ্তাহের বেশি থাকলে চর্মরোগ বিশেষজ্ঞ দেখান।`,
  },
  {
    keys: ['back pain', 'neck pain', 'komor betha', 'কোমর ব্যথা', 'পিঠে ব্যথা', 'ঘাড় ব্যথা', 'komor batha', 'pith betha', 'ghar betha', 'ghar batha', 'কোমরে ব্যথা', 'পিঠ ব্যথা', 'ঘাড়ে ব্যথা'],
    specialty: 'Orthopedics',
    en: `For back or neck pain:
• Keep gently active; long bed rest makes it worse.
• Warm compress for 15–20 minutes, 2–3 times a day.
• Sit straight, take breaks from the screen every 30 minutes, lift with your knees.
• Paracetamol as per the pack for pain.
See a doctor if: pain spreads down the leg with numbness, after a fall, with fever or weight loss, or trouble passing urine.`,
    bn: `কোমর বা ঘাড় ব্যথায়:
• হালকা নড়াচড়া চালিয়ে যান; দীর্ঘ সময় শুয়ে থাকলে ব্যথা বাড়ে।
• দিনে ২–৩ বার ১৫–২০ মিনিট গরম সেঁক দিন।
• সোজা হয়ে বসুন, প্রতি ৩০ মিনিটে স্ক্রিন থেকে বিরতি নিন, ভারী জিনিস হাঁটু ভাঁজ করে তুলুন।
• ব্যথার জন্য প্যাকেটের নিয়মে প্যারাসিটামল।
ডাক্তার দেখান যদি: ব্যথা পায়ে নেমে যায় ও অবশ লাগে, পড়ে যাওয়ার পর হয়, জ্বর বা ওজন কমে, বা প্রস্রাবে সমস্যা হয়।`,
  },
  {
    keys: ["can't sleep", 'insomnia', 'stress', 'anxiety', 'tension', 'ghum hoy na', 'ঘুম হয় না', 'ঘুম আসে না', 'টেনশন', 'দুশ্চিন্তা', 'মানসিক চাপ', 'ghum ase na', 'ghum hoy na', 'tension', 'ghum kom', 'ঘুমের সমস্যা', 'অনিদ্রা'],
    specialty: 'Psychiatry',
    en: `For stress or poor sleep:
• Keep the same sleep and wake time; no screens 1 hour before bed.
• Avoid tea/coffee after afternoon; get daylight and a 30-minute walk.
• Slow breathing: in for 4 seconds, hold 4, out for 6 — repeat for 5 minutes.
• Talk to someone you trust.
Get help if: low mood lasts more than 2 weeks, or you have thoughts of harming yourself — call 999 or the Kaan Pete Roi helpline.`,
    bn: `মানসিক চাপ বা ঘুমের সমস্যায়:
• প্রতিদিন একই সময়ে ঘুমাতে যান ও উঠুন; ঘুমানোর ১ ঘণ্টা আগে মোবাইল বন্ধ রাখুন।
• বিকেলের পর চা/কফি এড়িয়ে চলুন; দিনের আলোয় ৩০ মিনিট হাঁটুন।
• ধীরে শ্বাস নিন: ৪ সেকেন্ড শ্বাস নিন, ৪ সেকেন্ড ধরে রাখুন, ৬ সেকেন্ডে ছাড়ুন — ৫ মিনিট।
• বিশ্বস্ত কারো সাথে কথা বলুন।
সাহায্য নিন যদি: ২ সপ্তাহের বেশি মন খারাপ থাকে বা নিজের ক্ষতি করার চিন্তা আসে — ৯৯৯ বা 'কান পেতে রই' হেল্পলাইনে কল করুন।`,
  },
  {
    keys: ['high blood pressure', 'high pressure', 'hypertension', 'bp high', 'প্রেশার বেড়', 'উচ্চ রক্তচাপ', 'প্রেশার হাই', 'pressure beshi', 'pressure high', 'presar', 'bp beshi', 'প্রেশার বেশি', 'রক্তচাপ বেশি'],
    specialty: 'Cardiology',
    en: `If your blood pressure is high:
• Sit and rest for 5 minutes, then measure again.
• Take your prescribed BP medicine on time; never stop it suddenly.
• Reduce salt, pickles and fried food; walk 30 minutes a day; avoid smoking.
Get help now if: BP is 180/120 or above, or you have chest pain, severe headache, weakness on one side or trouble speaking — call 999.`,
    bn: `রক্তচাপ বেশি হলে:
• ৫ মিনিট বসে বিশ্রাম নিয়ে আবার মাপুন।
• প্রেসক্রিপশনের প্রেশারের ওষুধ সময়মতো খান; হঠাৎ বন্ধ করবেন না।
• লবণ, আচার ও ভাজাপোড়া কমান; প্রতিদিন ৩০ মিনিট হাঁটুন; ধূমপান করবেন না।
এখনই সাহায্য নিন যদি: প্রেশার ১৮০/১২০ বা বেশি হয়, অথবা বুকে ব্যথা, তীব্র মাথাব্যথা, শরীরের এক পাশ দুর্বল বা কথা জড়িয়ে যায় — ৯৯৯-এ কল করুন।`,
  },
  {
    keys: ['low sugar', 'hypo', 'sugar low', 'সুগার কমে', 'সুগার ফল', 'sugar kom', 'sugar kome', 'সুগার কম'],
    specialty: 'Endocrinology',
    en: `If blood sugar may be low (shaky, sweating, dizzy):
• Take 15 g fast sugar now: half a glass of juice, 3 teaspoons of sugar in water, or glucose.
• Check again after 15 minutes; repeat if still low, then eat a snack.
Call 999 if the person is drowsy, confused or cannot swallow.`,
    bn: `সুগার কমে গেলে (কাঁপুনি, ঘাম, মাথা ঘোরা):
• এখনই ১৫ গ্রাম দ্রুত চিনি খান: আধা গ্লাস জুস, পানিতে ৩ চা-চামচ চিনি, বা গ্লুকোজ।
• ১৫ মিনিট পর আবার মাপুন; তখনও কম থাকলে আবার খান, তারপর হালকা নাস্তা করুন।
রোগী ঝিমিয়ে পড়লে, বিভ্রান্ত হলে বা গিলতে না পারলে ৯৯৯-এ কল করুন।`,
  },
  {
    keys: ['period pain', 'menstrual pain', 'masik betha', 'মাসিকের ব্যথা', 'পিরিয়ডের ব্যথা', 'period betha', 'masik', 'মাসিক', 'পিরিয়ড'],
    specialty: 'Gynecology & Obstetrics',
    en: `For period pain:
• A hot water bottle on the lower belly.
• Light exercise or walking; drink warm water.
• Paracetamol or an anti-inflammatory as per the pack.
See a gynaecologist if: pain stops daily activities, bleeding is very heavy, periods are irregular, or there is pain between periods.`,
    bn: `মাসিকের ব্যথায়:
• তলপেটে গরম পানির ব্যাগ দিন।
• হালকা ব্যায়াম বা হাঁটা; কুসুম গরম পানি পান করুন।
• প্যাকেটের নিয়মে প্যারাসিটামল বা ব্যথানাশক।
গাইনি ডাক্তার দেখান যদি: ব্যথায় দৈনন্দিন কাজ বন্ধ হয়ে যায়, খুব বেশি রক্তপাত হয়, মাসিক অনিয়মিত হয়, বা মাসিকের মাঝেও ব্যথা হয়।`,
  },
  {
    keys: ['heat stroke', 'heatstroke', 'dehydration', 'gorom', 'হিট স্ট্রোক', 'পানিশূন্যতা', 'গরমে', 'gorome', 'pani shunnota', 'রোদে', 'হিটস্ট্রোক'],
    specialty: 'General Medicine',
    en: `For heat exhaustion or dehydration:
• Move to a cool, shaded place; loosen clothes.
• Drink ORS or water in small sips.
• Wet the skin with cool water and fan it.
Call 999 if: the person is confused, faints, stops sweating or has a very high temperature.`,
    bn: `গরমে ক্লান্তি বা পানিশূন্যতায়:
• ঠান্ডা, ছায়াযুক্ত জায়গায় নিন; কাপড় ঢিলে করুন।
• অল্প অল্প করে স্যালাইন বা পানি পান করান।
• ঠান্ডা পানি দিয়ে শরীর ভিজিয়ে বাতাস করুন।
৯৯৯-এ কল করুন যদি: রোগী বিভ্রান্ত হয়, অজ্ঞান হয়ে যায়, ঘাম বন্ধ হয়ে যায় বা তাপমাত্রা খুব বেশি হয়।`,
  },
];
// Bangla keys match anywhere (words inflect); English/Banglish keys match whole words.
const hit = (t, k) => (/[\u0980-\u09FF]/.test(k) ? t.includes(k.normalize('NFC')) : new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}`, 'i').test(t));
const norm = (m) => String(m || '').toLowerCase().normalize('NFC').replace(/ব্যাথ/g, 'ব্যথ').replace(/এ্যা/g, 'অ্যা').replace(/betha|bhetha|batha/g, (w) => w);
function adviceFor(message) {
  const t = norm(message);
  return TOPICS.find((x) => x.keys.some((k) => hit(t, k))) || allAdviceFor(message)[0] || null;
}
/** Every complaint mentioned in one message ("headache and stomach pain" -> two topics). */
// "পেটে খুব ব্যথা", "matha onek batha": a body part plus a pain word anywhere in the message.
const BODY_PAIN = [[/মাথা|\bmatha|\bmathay/, 'headache'], [/পেট|\bpet\b|\bpete\b|stomach|tummy/, 'stomach pain'], [/কোমর|পিঠ|ঘাড়|\bkomor|\bpith|\bghar\b|back|neck/, 'back pain'],
  [/দাঁত|মাড়ি|\bdat\b|\bdate\b|tooth|teeth/, 'toothache'], [/গলা|\bgola\b|throat/, 'cold'], [/মাসিক|পিরিয়ড|period|\bmasik/, 'period pain']];
const PAIN = /ব্যথা|ব্যাথা|যন্ত্রণা|\bbet?ha\b|\bbatha\b|\bbytha\b|pain|ache|hurts/;
function allAdviceFor(message) {
  const t = norm(message);
  const found = TOPICS.filter((x) => x.keys.some((k) => hit(t, k)));
  if (PAIN.test(t)) {
    for (const [re, key] of BODY_PAIN) {
      const topic = TOPICS.find((x) => x.keys[0] === key);
      if (re.test(t) && topic && !found.includes(topic)) found.push(topic);
    }
  }
  return found;
}
module.exports = { TOPICS, adviceFor, allAdviceFor };
