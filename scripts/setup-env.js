// Creates .env from .env.example on first install so the app runs straight away.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const env = path.join(root, '.env');
if (!fs.existsSync(env)) {
  const secret = require('node:crypto').randomBytes(32).toString('hex');
  const text = fs.readFileSync(path.join(root, '.env.example'), 'utf8').replace('change-me-to-a-long-random-string', secret);
  fs.writeFileSync(env, text);
  console.log('Created .env with a fresh SESSION_SECRET.');
}
