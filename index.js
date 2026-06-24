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
function blueBoxSpeech(s) {
  const ils = (n) => Math.round(n);
  let main;
  if (s.stillToGive > 0.01)       main = `עליך להעביר לשליח עוד ${ils(s.stillToGive)} שקלים`;
  else if (s.stillToGive < -0.01) main = `יש עודף אצל השליח של ${ils(Math.abs(s.stillToGive))} שקלים`;
  else                            main = 'אין צורך להעביר עוד לשליח';
  const debt = Math.abs(s.debtToAgent) < 0.01 ? 'אין חוב לאחראי' : `החוב לאחראי הוא ${ils(s.debtToAgent)} שקלים`;
  return `${main} ${debt}`;
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
