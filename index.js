/* =========================================================================
   רישום "נתתי לשליח" דרך הטלפון (ימות המשיח) → Firebase Firestore
   -------------------------------------------------------------------------
   הזרימה:  טלפון → מערכת ימות → השרת הזה → מסמך workspaces/<קוד> ב‑Firestore
            → האפליקציה שלך מתעדכנת אוטומטית (onSnapshot).
   ========================================================================= */

const express = require('express');
const admin = require('firebase-admin');
const { YemotRouter } = require('yemot-router2');

/* ---------- הגדרות (אפשר לשנות דרך משתני סביבה) ---------- */
const WORKSPACE_CODE = process.env.WORKSPACE_CODE || '037220172'; // קוד החיבור של המערכת שלך
const ENTRY_DESC     = process.env.ENTRY_DESC     || 'נרשם בטלפון'; // תיאור שמסמן שזה הגיע מהטלפון
const PIN            = process.env.PIN            || '';            // קוד גישה (ריק = ללא קוד). מומלץ למלא!
const PORT           = process.env.PORT           || 3000;

/* ---------- אתחול Firebase Admin ---------- */
// צריך קובץ serviceAccount.json (ראה README) או credentials דרך הסביבה.
admin.initializeApp({
  credential: admin.credential.cert(require('./serviceAccount.json')),
});
const db = admin.firestore();

/* ---------- תאריך/שעה בפורמט שהאפליקציה משתמשת בו ---------- */
function nowParts() {
  const tz = 'Asia/Jerusalem';
  const d = new Date();
  const date = d.toLocaleDateString('he-IL', { timeZone: tz });                 // למשל 23.6.2026
  const time = d.toLocaleTimeString('he-IL',
    { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });       // למשל 14:35
  return { date, time };
}

/* ---------- חישוב מצב חשבון השליח (זהה ל‑renderShipper באפליקציה) ---------- */
function computeShipperSummary(entries) {
  let given = 0, debtMain = 0, paidMain = 0;
  for (const e of entries) {
    if (e.ledger === 'shipper') { if (e.kind === 'shipper_pay') given += e.amount; }
    else if (e.kind === 'order' || e.kind === 'delivery' || e.kind === 'expense') debtMain += e.amount;
    else if (e.kind === 'payment') paidMain += e.amount;
  }
  const transferred    = paidMain;              // כסף שעבר מהשליח לאחראי
  const moneyAtShipper = given - transferred;   // כסף שיושב אצל השליח
  const debtToAgent    = debtMain - paidMain;   // החוב לאחראי
  const stillToGive    = debtToAgent - moneyAtShipper;
  return { given, transferred, moneyAtShipper, debtToAgent, stillToGive };
}

/* ---------- ניסוח הקראה של "הריבוע הכחול" (כרטיס: כמה עוד להעביר לשליח) ---------- */
function blueBoxSpeech(s) {
  const ils = (n) => Math.round(n); // שקלים שלמים להקראה ברורה
  let main;
  if (s.stillToGive > 0.01)        main = `עליך להעביר לשליח עוד ${ils(s.stillToGive)} שקלים`;
  else if (s.stillToGive < -0.01)  main = `יש עודף אצל השליח של ${ils(Math.abs(s.stillToGive))} שקלים`;
  else                             main = 'אין צורך להעביר עוד לשליח';

  const debt = Math.abs(s.debtToAgent) < 0.01
    ? 'אין חוב לאחראי'
    : `החוב לאחראי הוא ${ils(s.debtToAgent)} שקלים`;

  return `${main}. ${debt}.`;
}

/* ---------- כתיבת רשומת "נתתי לשליח" ל‑Firestore (בטוח, עם טרנזקציה) ---------- */
async function addShipperPayment(amount) {
  const { date, time } = nowParts();
  const entry = {
    id: 'SHP-' + Date.now(),
    ledger: 'shipper',
    kind: 'shipper_pay',
    date, time,
    amount: amount,
    desc: ENTRY_DESC,
  };

  const ref = db.collection('workspaces').doc(WORKSPACE_CODE);
  let summary;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const entries = Array.isArray(data.entries) ? data.entries : [];
    entries.unshift(entry); // בראש המערך — בדיוק כמו unshift באפליקציה (החדש למעלה)
    tx.set(ref, { entries, updatedAt: Date.now() }, { merge: true });
    summary = computeShipperSummary(entries); // חישוב על המצב המעודכן (כולל הרשומה החדשה)
  });

  return { entry, summary };
}

/* ---------- מערכת הטלפון (ימות) ---------- */
const router = YemotRouter();

router.get('/', async (call) => {
  try {
    // שלב קוד גישה (אם הוגדר PIN)
    if (PIN) {
      const pin = await call.read(
        [{ type: 'text', data: 'נא הקש את קוד הגישה, ואחריו סולמית' }],
        'tap', { max_digits: 8, min_digits: 1, sec_wait: 10 }
      );
      if (pin !== PIN) {
        return call.id_list_message([{ type: 'text', data: 'קוד שגוי. להתראות.' }]);
      }
    }

    // הקשת הסכום (שקלים שלמים)
    const raw = await call.read(
      [{ type: 'text', data: 'נא הקש את הסכום שנתת לשליח, בשקלים שלמים, ואחריו סולמית' }],
      'tap', { max_digits: 7, min_digits: 1, sec_wait: 10 }
    );
    const amount = parseInt(raw, 10);
    if (!amount || amount <= 0) {
      return call.id_list_message([{ type: 'text', data: 'סכום לא תקין. להתראות.' }]);
    }

    // אישור לפני שמירה
    const confirm = await call.read(
      [{ type: 'text', data: `הקשת ${amount} שקלים. לאישור הקש 1, לביטול הקש 2` }],
      'tap', { max_digits: 1, min_digits: 1, sec_wait: 8 }
    );
    if (confirm !== '1') {
      return call.id_list_message([{ type: 'text', data: 'הפעולה בוטלה. להתראות.' }]);
    }

    // שמירה ל‑Firestore + קבלת מצב חשבון השליח המעודכן
    const { summary } = await addShipperPayment(amount);

    // הקראת "הריבוע הכחול" בסוף השיחה
    return call.id_list_message([
      { type: 'text', data: `נרשם בהצלחה. נתת לשליח ${amount} שקלים.` },
      { type: 'text', data: blueBoxSpeech(summary) },
      { type: 'text', data: 'להתראות.' },
    ]);
  } catch (err) {
    console.error('Call error:', err);
    return call.id_list_message([{ type: 'text', data: 'אירעה שגיאה. נסה שוב מאוחר יותר.' }]);
  }
});

/* ---------- הפעלת השרת ---------- */
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(router);

app.get('/health', (_req, res) => res.send('OK'));

app.listen(PORT, () => console.log(`🚀 השרת רץ על פורט ${PORT}`));
