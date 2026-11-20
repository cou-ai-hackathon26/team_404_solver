// SMS delivery for phone verification (pharmacies and ambulances).
// SMS_PROVIDER=console prints the message in the terminal (default).
// SMS_PROVIDER=bulksmsbd uses bulksmsbd.net (Bangladesh) with SMS_API_KEY and SMS_SENDER_ID.
// SMS_PROVIDER=twilio uses Twilio with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.
const config = require('../config');

/** Bangladeshi numbers to 8801XXXXXXXXX. */
function normalize(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (/^01\d{9}$/.test(p)) p = `88${p}`;
  return p;
}

const consoleMode = () => config.sms.provider === 'console' || (config.sms.provider === 'bulksmsbd' && !config.sms.apiKey) || (config.sms.provider === 'twilio' && !config.sms.twilioSid);

function print(to, text, reason) {
  console.log(`\n================ SMS (${reason}) ================`);
  console.log(`To:   ${to}`);
  console.log(text);
  console.log('================================================\n');
}

async function sendSms(phone, text) {
  const to = normalize(phone);
  if (consoleMode()) { print(to, text, 'console mode'); return { console: true }; }
  try {
    let res;
    if (config.sms.provider === 'bulksmsbd') {
      const q = new URLSearchParams({ api_key: config.sms.apiKey, type: 'text', number: to, senderid: config.sms.senderId, message: text });
      res = await fetch(`http://bulksmsbd.net/api/smsapi?${q}`);
    } else {
      const auth = Buffer.from(`${config.sms.twilioSid}:${config.sms.twilioToken}`).toString('base64');
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.sms.twilioSid}/Messages.json`, {
        method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: `+${to}`, From: config.sms.twilioFrom, Body: text }),
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (e) {
    console.error(`SMS to ${to} failed (${e.message}). Check SMS settings in .env.`);
    print(to, text, 'SMS failed, printed instead');
    return { console: true, error: e.message };
  }
}

module.exports = { sendSms, normalize, consoleMode };
