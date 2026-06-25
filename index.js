/* =========================================================================
   רישום "נתתי לשליח" דרך הטלפון (ימות המשיח) → Firebase Firestore
   הזרימה: טלפון → ימות → השרת הזה → workspaces/<קוד> ב‑Firestore → האפליקציה
   ========================================================================= */

const express = require('express');
const admin = require('firebase-admin');
const { YemotRouter } = require('yemot-router2');

/* ---------- רשת ביטחון: שגיאה לא צפויה לא תפיל את השרת ---------- */
process.on('uncaughtException',  (err) => console.error('⚠️ uncaughtException:', err && err.message));
process.on('unhandledRejection', (err) => console.error('⚠️ unhandledRejection:', err && err.message));

/* ---------- הגדרות ---------- */
const WORKSPACE_CODE = process.env.WORKSPACE_CODE || '037220172';
const ENTRY_DESC     = process.env.ENTRY_DESC     || 'נרשם בטלפון';
const PIN            = process.env.PIN            || '';
const PORT           = process.env.PORT           || 3000;

/* ---------- Firebase ---------- */
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const db = admin.firestore();

/* ---------- תאריך/שעה כמו באפליקציה ---------- */
function nowParts() {
  const tz = 'Asia/Jerusalem';
  const d = new Date();
  return {
    date: d.toLocaleDateString('he-IL', { timeZone: tz }),
    time: d.toLocaleTimeString('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

/* ---------- חישוב מצב חשבון השליח ---------- */
function computeShipperSummary(entries) {
  let given = 0, debtMain = 0, paidMain = 0;
  for (const e of entries) {
    if (e.ledger === 'shipper') { if (e.kind === 'shipper_pay') given += Number(e.amount) || 0; }
    else if (e.kind === 'order' || e.kind === 'delivery' || e.kind === 'expense') debtMain += Number(e.amount) || 0;
    else if (e.kind === 'payment') paidMain += Number(e.amount) || 0;
  }
  const moneyAtShipper = given - paidMain;
  const debtToAgent    = debtMain - paidMain;
  const stillToGive    = debtToAgent - moneyAtShipper;
  return { debtToAgent, stillToGive };
}

/* ---------- ניסוח "הריבוע הכחול" ---------- */
const ils = (n) => Math.round(n);

// שורת מצב השליח (הריבוע הכחול)
function shipperLine(s) {
  if (s.stillToGive > 0.01)       return `עליך להעביר לשליח עוד ${ils(s.stillToGive)} שקלים`;
  else if (s.stillToGive < -0.01) return `יש עודף אצל השליח של ${ils(Math.abs(s.stillToGive))} שקלים`;
  else                            return 'אין צורך להעביר עוד לשליח';
}

// שורת החוב/עודף לאחראי
function agentDebtLine(s) {
  if (s.debtToAgent > 0.01)       return `החוב לאחראי הוא ${ils(s.debtToAgent)} שקלים`;
  else if (s.debtToAgent < -0.01) return `יש עודף אצל האחראי של ${ils(Math.abs(s.debtToAgent))} שקלים`;
  else                            return 'אין חוב לאחראי';
}

// שתי השורות יחד (לסיום שיחת הוספת כסף)
function blueBoxSpeech(s) {
  return `${shipperLine(s)} ${agentDebtLine(s)}`;
}

/* ---------- כתיבה ל‑Firestore ---------- */
async function addShipperPayment(amount) {
  const { date, time } = nowParts();
  const entry = { id: 'SHP-' + Date.now(), ledger: 'shipper', kind: 'shipper_pay', date, time, amount, desc: ENTRY_DESC };
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  let summary;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const entries = Array.isArray(data.entries) ? data.entries : [];
    entries.unshift(entry);
    tx.set(ref, { entries, updatedAt: Date.now() }, { merge: true });
    summary = computeShipperSummary(entries);
  });
  return { entry, summary };
}

/* ---------- קריאת מצב בלבד (בלי לכתוב) ---------- */
async function getSummary() {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return computeShipperSummary(entries);
}

/* ---------- מציאת הרשומה האחרונה של "נתתי לשליח" (בלי למחוק) ---------- */
async function getLastShipperPayment() {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  // הרשומות החדשות בראש המערך — נחפש את הראשונה מסוג shipper_pay
  const last = entries.find(e => e.ledger === 'shipper' && e.kind === 'shipper_pay');
  return last || null;
}

/* ---------- מציאת N הרשומות האחרונות של "נתתי לשליח" ---------- */
async function getRecentShipperPayments(n) {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return entries.filter(e => e.ledger === 'shipper' && e.kind === 'shipper_pay').slice(0, n);
}

/* ---------- מחיקת רשומת "נתתי לשליח" לפי מזהה (בטוח, עם טרנזקציה) ---------- */
async function deleteShipperPaymentById(id) {
  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  let summary, deleted = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const idx = entries.findIndex(e => e.id === id && e.ledger === 'shipper' && e.kind === 'shipper_pay');
    if (idx === -1) { summary = computeShipperSummary(entries); return; }
    entries.splice(idx, 1); // הסרת הרשומה
    tx.set(ref, { entries, updatedAt: Date.now() }, { merge: true });
    summary = computeShipperSummary(entries);
    deleted = true;
  });
  return { deleted, summary };
}

/* ---------- מערכת הטלפון ---------- */
const router = YemotRouter({ printLog: false, defaults: { removeInvalidChars: true, read: { timeout: 60000 } } });

router.get('/', async (call) => {
  console.log('📞 שיחה חדשה');
  try {
    if (PIN) {
      const pin = await call.read([{ type: 'text', data: 'נא הקש את קוד הגישה ואחריו סולמית' }],
        'tap', { max_digits: 8, min_digits: 1 });
      if (pin !== PIN) return call.id_list_message([{ type: 'text', data: 'קוד שגוי להתראות' }]);
    }

    // תפריט ראשי
    const choice = await call.read([{ type: 'text',
      data: 'להוספת כסף לשליח הקש 1 לשמיעת מצב השליח הקש 2 לשמיעת חוב לאחראי הקש 3 למחיקת הפעולה האחרונה הקש 4 לשמיעת הפעולות האחרונות הקש 5' }],
      'tap', { max_digits: 1, min_digits: 1, digits_allowed: [1, 2, 3, 4, 5] });
    console.log('   בחירת תפריט:', choice);

    /* ===== 2: שמיעת מצב השליח (עודף/חוב) בלבד ===== */
    if (choice === '2') {
      const s = await getSummary();
      return call.id_list_message([
        { type: 'text', data: shipperLine(s) },
        { type: 'text', data: 'להתראות' },
      ]);
    }

    /* ===== 3: שמיעת חוב/עודף לאחראי בלבד ===== */
    if (choice === '3') {
      const s = await getSummary();
      return call.id_list_message([
        { type: 'text', data: agentDebtLine(s) },
        { type: 'text', data: 'להתראות' },
      ]);
    }

    /* ===== 5: שמיעת הפעולות האחרונות ===== */
    if (choice === '5') {
      const recent = await getRecentShipperPayments(5);
      if (recent.length === 0) {
        return call.id_list_message([{ type: 'text', data: 'אין פעולות להשמעה להתראות' }]);
      }
      const msgs = [{ type: 'text', data: `יש ${recent.length} פעולות אחרונות` }];
      recent.forEach((e, i) => {
        const t = String(e.time || '').replace(/:/g, ' ');
        const parts = String(e.date || '').split(/[./]/);     // 23.6.2026 → [23,6,2026]
        const d = parts.slice(0, 2).join(' ');                 // יום וחודש בלבד: "23 6"
        msgs.push({ type: 'text', data: `פעולה ${i + 1} ${ils(e.amount)} שקלים בתאריך ${d} בשעה ${t}` });
      });
      msgs.push({ type: 'text', data: 'להתראות' });
      return call.id_list_message(msgs);
    }

    /* ===== 4: מחיקת הפעולה האחרונה של "נתתי לשליח" ===== */
    if (choice === '4') {
      const last = await getLastShipperPayment();
      if (!last) {
        return call.id_list_message([{ type: 'text', data: 'אין פעולות למחיקה להתראות' }]);
      }
      const safeTime = String(last.time || '').replace(/:/g, ' ');
      const delConfirm = await call.read([{ type: 'text',
        data: `הפעולה האחרונה היא ${ils(last.amount)} שקלים שנרשמה בשעה ${safeTime} למחיקה הקש 1 לביטול הקש 2` }],
        'tap', { max_digits: 1, min_digits: 1 });
      if (delConfirm !== '1') {
        return call.id_list_message([{ type: 'text', data: 'המחיקה בוטלה להתראות' }]);
      }
      const { deleted, summary } = await deleteShipperPaymentById(last.id);
      console.log('   🗑️ מחיקה:', last.amount, deleted ? 'הצליח' : 'לא נמצא');
      if (!deleted) {
        return call.id_list_message([{ type: 'text', data: 'הפעולה כבר נמחקה להתראות' }]);
      }
      return call.id_list_message([
        { type: 'text', data: `הפעולה נמחקה בהצלחה` },
        { type: 'text', data: blueBoxSpeech(summary) },
        { type: 'text', data: 'להתראות' },
      ]);
    }

    /* ===== 1: הוספת כסף לשליח ===== */
    const raw = await call.read([{ type: 'text', data: 'נא הקש את הסכום שנתת לשליח בשקלים שלמים ואחריו סולמית' }],
      'tap', { max_digits: 7, min_digits: 1 });
    console.log('   סכום שהוקש:', raw);
    const amount = parseInt(raw, 10);
    if (!amount || amount <= 0) return call.id_list_message([{ type: 'text', data: 'סכום לא תקין להתראות' }]);

    const confirm = await call.read([{ type: 'text', data: `הקשת ${amount} שקלים לאישור הקש 1 לביטול הקש 2` }],
      'tap', { max_digits: 1, min_digits: 1 });
    if (confirm !== '1') return call.id_list_message([{ type: 'text', data: 'הפעולה בוטלה להתראות' }]);

    const { summary } = await addShipperPayment(amount);
    console.log('   ✅ נרשם:', amount);

    return call.id_list_message([
      { type: 'text', data: `נרשם בהצלחה נתת לשליח ${amount} שקלים` },
      { type: 'text', data: blueBoxSpeech(summary) },
      { type: 'text', data: 'להתראות' },
    ]);
  } catch (err) {
    if (err && err.isExitError) return;               // המתקשר ניתק — לא שגיאה אמיתית
    console.error('❌ שגיאה בשיחה:', err && err.message ? err.message : err);
    try {
      return call.id_list_message([{ type: 'text', data: 'אירעה שגיאה נסה שוב מאוחר יותר' }]);
    } catch (e2) {
      console.error('   (לא ניתן היה לשלוח הודעת שגיאה)');
    }
  }
});

/* ---------- שרת ---------- */
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(router);
app.get('/health', (_req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`🚀 השרת רץ על פורט ${PORT}`));
