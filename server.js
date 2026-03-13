const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// =============================================
// CONFIG - APNI VALUES YAHAN DAALEN
// =============================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'bakery123';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'YOUR_WHATSAPP_TOKEN';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || 'YOUR_PHONE_NUMBER_ID';
const OWNER_PHONE = process.env.OWNER_PHONE || 'YOUR_OWNER_WHATSAPP_NUMBER'; // e.g. 923001234567

// =============================================
// BAKERY PRODUCTS LIST
// =============================================
const PRODUCTS = [
  'Jumbo Bread Choti',
  'Jumbo Bread Bari',
  'T3 Papa',
  'Slice Papa',
  'Gol Papa',
  'Sheermal',
  'Phool Bun'
];

// =============================================
// ORDER STORAGE (in-memory)
// =============================================
let todaysOrders = {};
let orderDate = getTodayDate();

function getTodayDate() {
  return new Date().toLocaleDateString('en-PK', { 
    timeZone: 'Asia/Karachi',
    day: '2-digit', month: '2-digit', year: 'numeric' 
  });
}

// Reset orders at midnight
setInterval(() => {
  const today = getTodayDate();
  if (today !== orderDate) {
    orderDate = today;
    todaysOrders = {};
    console.log('Orders reset for new day');
  }
}, 60000);

// =============================================
// GEMINI AI - ORDER PARSER
// =============================================
async function parseOrderWithAI(message, customerName) {
  const prompt = `
Tum ek bakery order parser ho. Customer ne yeh message bheja hai:
"${message}"

Bakery ke products yeh hain:
${PRODUCTS.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Customer Roman Urdu, Urdu, Sindhi, ya English mein likh sakta hai. Spelling mistakes bhi ho sakti hain.
Jaise "bored" = Bread, "paapy/papy/papay" = Papa, "shrmaal/shirmal" = Sheermal, etc.

Sirf JSON format mein jawab do, koi aur text nahi:
{
  "orders": [
    {"product": "exact product name from list", "quantity": number}
  ],
  "understood": true/false,
  "message": "agar kuch samajh na aaye to yahan likho"
}

Agar koi product list mein nahi hai, ignore karo.
Agar quantity nahi likhi to 1 assume karo.
Sirf JSON, koi markdown nahi.
`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
      }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('Gemini error:', err.message);
    return { understood: false, orders: [], message: 'AI error' };
  }
}

// =============================================
// WHATSAPP MESSAGE SENDER
// =============================================
async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('WhatsApp send error:', err.response?.data || err.message);
  }
}

// =============================================
// FORMAT ORDER SUMMARY
// =============================================
function formatOrderConfirmation(customerName, orders) {
  let msg = `✅ Shukriya ${customerName} bhai!\n\nAapka order note ho gaya:\n`;
  msg += `─────────────────\n`;
  orders.forEach(o => {
    msg += `📦 ${o.product}: ${o.quantity}\n`;
  });
  msg += `─────────────────\n`;
  msg += `Kal delivery hogi. Allah Hafiz! 🙏`;
  return msg;
}

function formatOwnerSummary() {
  const customers = Object.keys(todaysOrders);
  if (customers.length === 0) return null;

  // Tally totals
  const totals = {};
  PRODUCTS.forEach(p => totals[p] = 0);

  let msg = `📋 AAJ KE ORDERS — ${orderDate}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  customers.forEach((phone, i) => {
    const order = todaysOrders[phone];
    msg += `${i + 1}. ${order.name} (${phone})\n`;
    order.items.forEach(item => {
      msg += `   • ${item.product}: ${item.quantity}\n`;
      if (totals[item.product] !== undefined) {
        totals[item.product] += item.quantity;
      }
    });
    msg += `\n`;
  });

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 TOTAL SUMMARY:\n`;
  PRODUCTS.forEach(p => {
    if (totals[p] > 0) {
      msg += `${p}: ${totals[p]}\n`;
    }
  });
  msg += `\nTotal Customers: ${customers.length}`;

  return msg;
}

// =============================================
// WEBHOOK - WHATSAPP VERIFICATION
// =============================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// =============================================
// WEBHOOK - INCOMING MESSAGES
// =============================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from;
    const msgType = msg.type;

    // Get customer name from contacts
    const contacts = value?.contacts;
    const customerName = contacts?.[0]?.profile?.name || 'Customer';

    // Only handle text messages
    if (msgType !== 'text') {
      await sendWhatsAppMessage(from,
        `Salam ${customerName} bhai! 😊\n\nSirf text mein order likhein please.\n\nJaise:\n"10 jumbo bread choti\n5 sheermal\n3 gol papa"`
      );
      return;
    }

    const text = msg.text.body.trim().toLowerCase();

    // COMMANDS
    if (text === 'summary' || text === 'report' || text === 'orders') {
      // Only owner can see summary
      if (from === OWNER_PHONE) {
        const summary = formatOwnerSummary();
        if (summary) {
          await sendWhatsAppMessage(from, summary);
        } else {
          await sendWhatsAppMessage(from, 'Abhi tak koi order nahi aaya aaj.');
        }
      }
      return;
    }

    if (text === 'list' || text === 'products' || text === 'menu') {
      let menuMsg = `🥖 *BAKERY PRODUCTS LIST*\n─────────────────\n`;
      PRODUCTS.forEach((p, i) => {
        menuMsg += `${i + 1}. ${p}\n`;
      });
      menuMsg += `─────────────────\nOrder dene ke liye products aur quantity likhein.\nJaise: "10 sheermal, 5 gol papa"`;
      await sendWhatsAppMessage(from, menuMsg);
      return;
    }

    // PARSE ORDER WITH AI
    const parsed = await parseOrderWithAI(text, customerName);

    if (!parsed.understood || parsed.orders.length === 0) {
      await sendWhatsAppMessage(from,
        `Salam ${customerName} bhai! 😊\n\nMujhe order samajh nahi aaya.\n\nIs tarah likhein:\n"10 jumbo bread\n5 sheermal\n3 gol papa"\n\nYa "list" likhein products dekhne ke liye.`
      );
      return;
    }

    // Save order
    todaysOrders[from] = {
      name: customerName,
      phone: from,
      items: parsed.orders,
      time: new Date().toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi' })
    };

    // Confirm to customer
    const confirmation = formatOrderConfirmation(customerName, parsed.orders);
    await sendWhatsAppMessage(from, confirmation);

    // Notify owner
    if (OWNER_PHONE && from !== OWNER_PHONE) {
      let ownerNotif = `🔔 *NAYA ORDER*\n`;
      ownerNotif += `👤 ${customerName} (${from})\n`;
      ownerNotif += `─────────────────\n`;
      parsed.orders.forEach(o => {
        ownerNotif += `📦 ${o.product}: ${o.quantity}\n`;
      });
      ownerNotif += `─────────────────\n`;
      ownerNotif += `⏰ ${new Date().toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi' })}`;
      await sendWhatsAppMessage(OWNER_PHONE, ownerNotif);
    }

  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// =============================================
// DASHBOARD - ORDERS VIEW
// =============================================
app.get('/', (req, res) => {
  const customers = Object.keys(todaysOrders);
  const totals = {};
  PRODUCTS.forEach(p => totals[p] = 0);
  customers.forEach(phone => {
    todaysOrders[phone].items.forEach(item => {
      if (totals[item.product] !== undefined) totals[item.product] += item.quantity;
    });
  });

  let html = `<!DOCTYPE html>
<html>
<head>
  <title>Bakery Orders</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #f0f2f5; padding: 20px; }
    h1 { color: #1a1a2e; margin-bottom: 5px; }
    .date { color: #666; margin-bottom: 20px; font-size: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media(max-width:600px) { .grid { grid-template-columns: 1fr; } }
    .card { background: white; border-radius: 12px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .card h2 { font-size: 16px; color: #333; margin-bottom: 12px; border-bottom: 2px solid #f0f0f0; padding-bottom: 8px; }
    .order-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f5f5f5; font-size: 14px; }
    .order-row:last-child { border: none; }
    .qty { font-weight: bold; color: #e63946; }
    .customer-name { font-weight: bold; color: #1d3557; }
    .customer-time { font-size: 11px; color: #999; }
    .total-card { background: #1d3557; color: white; border-radius: 12px; padding: 16px; }
    .total-card h2 { color: white; margin-bottom: 12px; border-bottom: 2px solid rgba(255,255,255,0.2); padding-bottom: 8px; }
    .total-row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 14px; }
    .total-qty { font-weight: bold; color: #a8dadc; }
    .badge { display: inline-block; background: #e63946; color: white; border-radius: 20px; padding: 2px 10px; font-size: 12px; margin-left: 8px; }
    .empty { text-align: center; color: #999; padding: 40px; }
    .refresh { background: #457b9d; color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>🥖 Bakery Orders Dashboard</h1>
  <p class="date">📅 ${orderDate} — Total Customers: <strong>${customers.length}</strong></p>
  <button class="refresh" onclick="location.reload()">🔄 Refresh</button>
  <br><br>
  <div class="grid">`;

  // Total summary card
  html += `<div class="total-card"><h2>📊 AAJ KA TOTAL</h2>`;
  let hasAny = false;
  PRODUCTS.forEach(p => {
    if (totals[p] > 0) {
      hasAny = true;
      html += `<div class="total-row"><span>${p}</span><span class="total-qty">${totals[p]}</span></div>`;
    }
  });
  if (!hasAny) html += `<p style="color:rgba(255,255,255,0.6);font-size:14px;margin-top:10px;">Abhi tak koi order nahi</p>`;
  html += `</div>`;

  // Individual orders
  html += `<div class="card"><h2>👥 CUSTOMERS <span class="badge">${customers.length}</span></h2>`;
  if (customers.length === 0) {
    html += `<div class="empty">Koi order nahi abhi tak</div>`;
  } else {
    customers.forEach(phone => {
      const o = todaysOrders[phone];
      html += `<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #f0f0f0;">`;
      html += `<div class="customer-name">${o.name}</div>`;
      html += `<div class="customer-time">⏰ ${o.time}</div>`;
      o.items.forEach(item => {
        html += `<div class="order-row"><span>${item.product}</span><span class="qty">${item.quantity}</span></div>`;
      });
      html += `</div>`;
    });
  }
  html += `</div></div>`;

  html += `<br><small style="color:#999">Auto refresh nahi — refresh button dabao update ke liye</small>`;
  html += `</body></html>`;
  res.send(html);
});

// =============================================
// START
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🥖 Bakery AI Server running on port ${PORT}`);
});
