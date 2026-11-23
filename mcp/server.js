// MediConnect MCP server: lets any MCP client (Claude Desktop, Cursor, another AI agent) use
// MediConnect's public, read-only AI tools. No patient records are exposed.
// Run: npm run mcp   (stdio transport)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const db = require('../src/db');
const { classifySpecialties, rankDoctors, redFlags, SPECIALTIES } = require('../src/services/recommender');
const { adviceFor } = require('../src/services/firstaid');

// MCP uses stdout for the protocol, so app logs go to stderr.
console.log = (...a) => console.error(...a);

// A fresh install has no data yet: load the demo data, as the web app does on first start.
if (!db.get('SELECT COUNT(*) AS n FROM users').n) require('../src/seed').seed();

const server = new McpServer({ name: 'mediconnect-mcp', version: '1.0.0' });
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

server.registerTool('find_specialist', {
  title: 'Find the right specialist',
  description: 'Map symptoms written in Bangla, English or Banglish to 1-3 medical specialties, with emergency red flags.',
  inputSchema: { symptoms: z.string().min(2).max(2000) },
}, async ({ symptoms }) => {
  const specialties = classifySpecialties({ current_problems: symptoms }).slice(0, 3);
  const flags = redFlags({ current_problems: symptoms }) || [];
  return text({ specialties, emergency: flags.length ? { red_flags: flags, advice: 'Call 999 or go to the nearest emergency department now.' } : null, note: 'Decision support only, not a diagnosis.' });
});

server.registerTool('search_doctors', {
  title: 'Search verified doctors',
  description: 'List verified MediConnect doctors for a specialty, ranked by experience, availability, distance and fee.',
  inputSchema: {
    specialty: z.enum(SPECIALTIES),
    lat: z.number().optional(), lng: z.number().optional(),
    max_fee: z.number().optional(), limit: z.number().int().min(1).max(20).optional(),
  },
}, async ({ specialty, lat, lng, max_fee, limit }) => {
  const patient = lat != null && lng != null ? { lat, lng } : null;
  const list = rankDoctors({ specialties: [{ specialty, confidence: 1 }], patient, maxFee: max_fee })
    .slice(0, limit || 5)
    .map((d) => ({ name: d.full_name, specialty: d.specialty, experience_years: d.experience_years, fee_bdt: d.fee, distance_km: d.distance == null ? null : Math.round(d.distance * 10) / 10, score: d.score }));
  return text(list.length ? list : `No verified ${specialty} doctors found.`);
});

server.registerTool('first_aid', {
  title: 'First-aid advice',
  description: 'Look up first-aid and self-care steps from the bilingual MediConnect knowledge base (Bangla or English).',
  inputSchema: { question: z.string().min(2).max(1000), language: z.enum(['en', 'bn']).optional() },
}, async ({ question, language }) => {
  const aid = adviceFor(question);
  if (!aid) return text('No matching first-aid topic. If symptoms are severe or sudden, call 999.');
  return text({ advice: language === 'bn' ? aid.bn : aid.en, see_specialist: aid.specialty, note: 'General advice, not a diagnosis.' });
});

server.registerTool('list_specialties', {
  title: 'List specialties',
  description: 'All medical specialties MediConnect can route to.',
  inputSchema: {},
}, async () => text(SPECIALTIES));

server.connect(new StdioServerTransport()).then(() => console.error('mediconnect-mcp ready (stdio): find_specialist, search_doctors, first_aid, list_specialties'));
